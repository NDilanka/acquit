// The GitHub App boundary. The App is an operator item, so the deployment wires one of three ports:
// the fake for the unit path and development, the fail-fast adapter while the App is absent, or the
// App client once the operator provisions it. Nothing here ever waits on a network call it cannot make.

import { createPrivateKey, createSign } from "node:crypto";
import type { CommitSha, JobId } from "./ids.ts";

export type GitHubAppConfig = {
	readonly appId: string;
	readonly privateKey: string;
	/** The organization that holds one pushed work repository per job. */
	readonly organization: string;
	readonly apiBase: string;
	/** Every request is bounded by this. A call that cannot answer in time refuses by name. */
	readonly timeoutMs: number;
};

export type GitHubAppConfigInput = Partial<Omit<GitHubAppConfig, "apiBase">> & { readonly apiBase?: string };

export class GitHubAppNotConfigured extends Error {
	readonly code = "GITHUB_APP_NOT_CONFIGURED";
	constructor(detail = "The GitHub App is not configured.") { super(detail); }
}

/** Every refusal the App client makes. The code is the name an operator acts on. */
export type GitHubFailureCode =
	| "GITHUB_APP_KEY_INVALID"
	| "GITHUB_INSTALLATION_MISSING"
	| "GITHUB_PERMISSION_MISSING"
	| "GITHUB_RATE_LIMITED"
	| "GITHUB_TIMEOUT"
	| "GITHUB_NETWORK"
	| "GITHUB_NOT_FOUND"
	| "GITHUB_COMMIT_ABSENT"
	| "GITHUB_REF_CONFLICT"
	| "GITHUB_RESPONSE_INVALID"
	| "GITHUB_HTTP_ERROR";

export class GitHubAppError extends Error {
	readonly code: GitHubFailureCode;
	readonly status: number | null;
	/** The permission GitHub named as missing, when the refusal was a permission. */
	readonly permission: string | null;
	constructor(code: GitHubFailureCode, detail: string, options: { readonly status?: number; readonly permission?: string | null } = {}) {
		super(detail);
		this.name = "GitHubAppError";
		this.code = code;
		this.status = options.status ?? null;
		this.permission = options.permission ?? null;
	}
}

export type WorkRepo = {
	/** `acquit-forks/invoice-app-<job>`, the repository the frozen commit is pushed to. */
	readonly repository: string;
	readonly remote: string;
	readonly branch: string;
	readonly commit: CommitSha;
};

export type PublishedPullRequest = {
	readonly repository: string;
	readonly pullRequest: number;
	/** The immutable commit the PR head points at. Approval, merge, and the receipt bind to this, never to a moving head. */
	readonly mergeCommit: CommitSha;
	readonly checkRunUrl: string | null;
};

export type WorkRepoRequest = { readonly jobId: JobId; readonly repository: string; readonly frozenCommit: CommitSha };
export type PublishRequest = { readonly jobId: JobId; readonly repository: string; readonly sourceCommit: CommitSha; readonly checkName: string };

/** What the core's outbox needs. */
export interface WorkRepoPort {
	/** Idempotent per job: a retry adopts the existing repository instead of creating a second one. */
	createWorkRepo(request: WorkRepoRequest, requestId: string): Promise<WorkRepo>;
}

/** What the judge needs after a clean run. */
export interface PublisherPort {
	/** Idempotent per job and commit: a retry reuses the branch, the pull request, and the check run. */
	publishVerified(request: PublishRequest, requestId: string): Promise<PublishedPullRequest>;
}

export interface GitHubAppPort extends WorkRepoPort, PublisherPort {}

/** Boundary parse. A partial config is not an error here; it selects the fail-fast adapter. */
export function parseGitHubAppConfig(input: GitHubAppConfigInput | undefined): GitHubAppConfig | null {
	const appId = input?.appId?.trim() ?? "";
	const privateKey = input?.privateKey?.trim() ?? "";
	const organization = input?.organization?.trim() ?? "";
	if (!appId || !privateKey || !organization) return null;
	const timeout = Number(input?.timeoutMs);
	return { appId, privateKey, organization, apiBase: input?.apiBase?.trim() || "https://api.github.com",
		timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000 };
}

export function missingGitHubNames(input: GitHubAppConfigInput | undefined): readonly string[] {
	return [["GITHUB_APP_ID", input?.appId], ["GITHUB_APP_PRIVATE_KEY", input?.privateKey], ["GITHUB_APP_ORG", input?.organization]]
		.filter(([, value]) => !value?.trim()).map(([name]) => String(name));
}

/** Every call refuses immediately. It never starts a request it cannot authenticate. */
export function unconfiguredGitHubApp(detail = `Missing ${missingGitHubNames({}).join(", ")}.`): GitHubAppPort {
	const fail = (): never => { throw new GitHubAppNotConfigured(detail); };
	return { createWorkRepo: async () => fail(), publishVerified: async () => fail() };
}

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** An RS256 App JWT. `iat` is backdated a minute for clock skew and `exp` stays under GitHub's ten-minute cap. */
function appJwt(appId: string, privateKey: string, nowMs: number): string {
	let key;
	try { key = createPrivateKey({ key: privateKey, format: "pem" }); }
	catch { throw new GitHubAppError("GITHUB_APP_KEY_INVALID", "ACQUIT_GITHUB_APP_PRIVATE_KEY does not parse as a PEM private key."); }
	const seconds = Math.floor(nowMs / 1000);
	const claims = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))}`;
	const signer = createSign("RSA-SHA256");
	signer.update(claims);
	return `${claims}.${signer.sign(key, "base64url")}`;
}

export function createGitHubApp(config: GitHubAppConfigInput | undefined): GitHubAppPort {
	const parsed = parseGitHubAppConfig(config);
	if (!parsed) return unconfiguredGitHubApp(`Missing ${missingGitHubNames(config).join(", ")}.`);
	return appClient(parsed);
}

type Answer = { readonly status: number; readonly body: unknown };
type Call = { readonly method: string; readonly path: string; readonly body?: unknown;
	readonly allow: readonly number[]; readonly permission?: string };

/** One token per owner, refreshed shortly before GitHub expires it. */
const REFRESH_MARGIN_MS = 60_000;

/** The work repository's branch, held at the frozen commit the submitter starts from. */
const WORK_REPO_BRANCH = "main";

function appClient(parsed: GitHubAppConfig): GitHubAppPort {
	const tokens = new Map<string, { readonly token: string; readonly expiresAtMs: number }>();
	const minting = new Map<string, Promise<string>>();
	let installations: Promise<readonly { readonly id: number; readonly account: string }[]> | null = null;

	const textOf = (value: unknown, key: string): string | null => {
		const found = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
		return typeof found === "string" ? found : null;
	};
	const numberOf = (value: unknown, key: string): number => {
		const found = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
		if (typeof found !== "number" || !Number.isSafeInteger(found) || found <= 0) {
			throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `The answer carried no ${key}.`);
		}
		return found;
	};
	const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
	const said = (body: unknown): string => textOf(body, "message") ?? "";

	const refusal = (status: number, body: unknown, headers: Headers, spec: Call): GitHubAppError => {
		const detail = `${spec.method} ${spec.path} answered ${status}${said(body) ? `: ${said(body)}` : "."}`;
		const accepted = (headers.get("x-accepted-github-permissions") ?? "").split(",").map(item => item.trim()).filter(Boolean);
		const permission = accepted[0] ?? spec.permission ?? null;
		const missing = permission === null ? "" : ` Missing permission: ${permission}.`;
		if (status === 403 || status === 429) {
			const reset = Number(headers.get("x-ratelimit-reset"));
			if (status === 429 || headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(said(body))) {
				const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "an unstated time";
				return new GitHubAppError("GITHUB_RATE_LIMITED", `${detail} The rate limit resets at ${at}.`, { status });
			}
			return new GitHubAppError("GITHUB_PERMISSION_MISSING", `${detail}${missing}`, { status, permission });
		}
		if (status === 401) return new GitHubAppError("GITHUB_PERMISSION_MISSING", `${detail}${missing}`, { status, permission });
		if (status === 404) return new GitHubAppError("GITHUB_NOT_FOUND", detail, { status });
		return new GitHubAppError("GITHUB_HTTP_ERROR", detail, { status });
	};

	const call = async (authorization: string, spec: Call): Promise<Answer> => {
		let response: Response;
		let text: string;
		try {
			response = await fetch(`${parsed.apiBase}${spec.path}`, {
				method: spec.method,
				headers: { accept: "application/vnd.github+json", authorization, "x-github-api-version": "2022-11-28",
					"user-agent": `acquit-verifier/${parsed.appId}`, ...(spec.body === undefined ? {} : { "content-type": "application/json" }) },
				body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
				signal: AbortSignal.timeout(parsed.timeoutMs),
			});
			text = await response.text();
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new GitHubAppError("GITHUB_TIMEOUT", `${spec.method} ${spec.path} timed out after ${parsed.timeoutMs} ms.`);
			}
			throw new GitHubAppError("GITHUB_NETWORK", `${spec.method} ${spec.path} could not reach ${parsed.apiBase}: ${messageOf(error)}`);
		}
		let body: unknown = null;
		if (text.trim() !== "") {
			try { body = JSON.parse(text); }
			catch { throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `${spec.method} ${spec.path} answered ${response.status} with a body that is not JSON.`, { status: response.status }); }
		}
		if (!spec.allow.includes(response.status)) throw refusal(response.status, body, response.headers, spec);
		return { status: response.status, body };
	};

	const appCall = (spec: Call): Promise<Answer> => call(`Bearer ${appJwt(parsed.appId, parsed.privateKey, Date.now())}`, spec);

	const installationsOf = async (): Promise<readonly { readonly id: number; readonly account: string }[]> => {
		installations ??= (async () => {
			const found: { id: number; account: string }[] = [];
			for (let page = 1; page <= 10; page++) {
				const answer = await appCall({ method: "GET", path: `/app/installations?per_page=100&page=${page}`, allow: [200] });
				// The list endpoint answers with a bare array; the live smoke pinned that against real GitHub.
				const items = answer.body;
				if (!Array.isArray(items)) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", "GET /app/installations answered without a list of installations.");
				for (const item of items) {
					const id = (item as { id?: unknown }).id;
					const account = textOf((item as { account?: unknown }).account, "login");
					if (typeof id === "number" && Number.isSafeInteger(id) && account !== null) found.push({ id, account });
				}
				if (items.length < 100) break;
			}
			return found;
		})();
		installations.catch(() => { installations = null; });
		return installations;
	};

	const tokenFor = async (owner: string): Promise<string> => {
		const cached = tokens.get(owner);
		if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cached.token;
		const running = minting.get(owner);
		if (running) return running;
		const mint = (async () => {
			const list = await installationsOf();
			const installation = list.find(item => item.account.toLowerCase() === owner.toLowerCase());
			if (installation === undefined) {
				throw new GitHubAppError("GITHUB_INSTALLATION_MISSING", `The App has no installation on ${owner}. Install the App on ${owner} before this call.`);
			}
			const answer = await appCall({ method: "POST", path: `/app/installations/${installation.id}/access_tokens`, allow: [201] });
			const token = textOf(answer.body, "token");
			if (token === null) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `The installation token for ${owner} carried no token.`);
			const expiresAt = Date.parse(textOf(answer.body, "expires_at") ?? "");
			tokens.set(owner, { token, expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : 0 });
			return token;
		})();
		minting.set(owner, mint);
		try { return await mint; } finally { minting.delete(owner); }
	};

	const splitRepository = (repository: string): { readonly owner: string; readonly name: string } => {
		const [owner, name, ...rest] = repository.split("/");
		if (!owner || !name || rest.length > 0) throw new Error(`${repository} is not an owner/name repository.`);
		return { owner, name };
	};

	const readRef = async (repository: string, branch: string, token: string): Promise<string | null> => {
		const answer = await call(`Bearer ${token}`, { method: "GET", path: `/repos/${repository}/git/ref/heads/${branch}`,
			allow: [200, 404], permission: "contents: read" });
		if (answer.status === 404) return null;
		const sha = textOf((answer.body as { object?: unknown })?.object, "sha");
		if (sha === null) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `The ref ${branch} on ${repository} carried no object sha.`);
		return sha;
	};

	const createRef = async (repository: string, branch: string, commit: CommitSha, token: string): Promise<void> => {
		const answer = await call(`Bearer ${token}`, { method: "POST", path: `/repos/${repository}/git/refs`, allow: [201, 422],
			permission: "contents: write", body: { ref: `refs/heads/${branch}`, sha: commit } });
		if (answer.status === 422) {
			throw new GitHubAppError("GITHUB_COMMIT_ABSENT", `${repository} cannot take ${branch} at ${commit}: ${said(answer.body) || "the object is not in this repository"}.`, { status: 422 });
		}
	};

	const ensureBranch = async (repository: string, branch: string, commit: CommitSha, token: string): Promise<void> => {
		const existing = await readRef(repository, branch, token);
		if (existing === null) { await createRef(repository, branch, commit, token); return; }
		if (existing !== commit) throw new GitHubAppError("GITHUB_REF_CONFLICT", `${repository} has ${branch} at ${existing}, not ${commit}.`);
	};

	const forkWorkRepo = async (repository: string, name: string, source: { readonly owner: string; readonly name: string }, orgToken: string): Promise<boolean> => {
		// The target org's installation makes the fork: GitHub checks administration on the org plus the
		// App's read access to the source, and it refuses the source installation's token. The r10 live
		// probe pinned both answers: 202 with the org token, 403 administration=write with the source one.
		const answer = await call(`Bearer ${orgToken}`, { method: "POST", path: `/repos/${source.owner}/${source.name}/forks`,
			allow: [200, 202, 422], permission: "administration: write", body: { organization: parsed.organization, name, default_branch_only: false } });
		// 202 is a fork this call made; 200 is a fork that already existed, which this call must not rewrite.
		if (answer.status === 200) return false;
		if (answer.status === 422) {
			// A concurrent attempt won the name. Adopt the repository and leave its refs alone.
			const again = await call(`Bearer ${orgToken}`, { method: "GET", path: `/repos/${repository}`, allow: [200, 404], permission: "administration: write" });
			if (again.status === 200) return false;
			throw new GitHubAppError("GITHUB_HTTP_ERROR", `POST /repos/${source.owner}/${source.name}/forks answered 422: ${said(answer.body) || "the name is taken"}.`, { status: 422 });
		}
		const created = textOf(answer.body, "full_name");
		if (created === null || created.toLowerCase() === repository.toLowerCase()) return true;
		// GitHub ignored the requested name. Rename before anyone works in the wrong repository.
		await call(`Bearer ${orgToken}`, { method: "PATCH", path: `/repos/${created}`, allow: [200], permission: "administration: write", body: { name } });
		return true;
	};

	const createWorkRepo = async (request: WorkRepoRequest): Promise<WorkRepo> => {
		const source = splitRepository(request.repository);
		const name = workRepoName(request.repository, request.jobId);
		const repository = `${parsed.organization}/${name}`;
		// The org installation answers for everything inside the org, so its absence refuses before any write.
		const orgToken = await tokenFor(parsed.organization);
		const found = await call(`Bearer ${orgToken}`, { method: "GET", path: `/repos/${repository}`, allow: [200, 404], permission: "administration: write" });
		const fresh = found.status === 404 ? await forkWorkRepo(repository, name, source, orgToken) : false;
		const existing = await readRef(repository, WORK_REPO_BRANCH, orgToken);
		if (existing === null) await createRef(repository, WORK_REPO_BRANCH, request.frozenCommit, orgToken);
		else if (existing !== request.frozenCommit) {
			// A fresh fork's main follows the client's head. Only a repository this call created is moved;
			// an existing one is refused by name, because moving it would rewrite state this call did not make.
			if (!fresh) throw new GitHubAppError("GITHUB_REF_CONFLICT", `${repository} has ${WORK_REPO_BRANCH} at ${existing}, not the frozen commit ${request.frozenCommit}.`);
			await call(`Bearer ${orgToken}`, { method: "PATCH", path: `/repos/${repository}/git/refs/heads/${WORK_REPO_BRANCH}`, allow: [200],
				permission: "contents: write", body: { sha: request.frozenCommit, force: true } });
		}
		return { repository, remote: `https://github.com/${repository}.git`, branch: WORK_REPO_BRANCH, commit: request.frozenCommit };
	};

	const findOrOpenPullRequest = async (request: PublishRequest, branch: string, headOwner: string, clientToken: string): Promise<number> => {
		const head = `${headOwner}:${branch}`;
		const list = async (): Promise<{ number?: unknown; state?: unknown }[]> => {
			const answer = await call(`Bearer ${clientToken}`, { method: "GET",
				path: `/repos/${request.repository}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=100`,
				allow: [200], permission: "pull_requests: read" });
			if (!Array.isArray(answer.body)) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `GET pulls on ${request.repository} answered without a list.`);
			return answer.body as { number?: unknown; state?: unknown }[];
		};
		const found = await list();
		const adopted = found.find(pull => pull.state === "open") ?? found[0];
		if (adopted !== undefined) return numberOf(adopted, "number");
		const repository = await call(`Bearer ${clientToken}`, { method: "GET", path: `/repos/${request.repository}`, allow: [200], permission: "pull_requests: write" });
		const created = await call(`Bearer ${clientToken}`, { method: "POST", path: `/repos/${request.repository}/pulls`, allow: [201, 422],
			permission: "pull_requests: write", body: { title: `Acquit verifier: ${request.jobId}`, head, draft: false,
				base: textOf(repository.body, "default_branch") ?? "main",
				body: `Verified by the Acquit verifier for ${request.jobId}.\n\nVerified commit: \`${request.sourceCommit}\`\n` } });
		if (created.status === 201) return numberOf(created.body, "number");
		// A concurrent publish won the head: adopt the pull request it opened.
		const again = await list();
		if (again[0] !== undefined) return numberOf(again[0], "number");
		throw new GitHubAppError("GITHUB_HTTP_ERROR", `POST pulls on ${request.repository} answered 422 with no pull request for ${head}.`, { status: 422 });
	};

	const findOrPostCheckRun = async (repository: string, commit: CommitSha, name: string, token: string, jobId: JobId): Promise<string | null> => {
		const list = async (): Promise<{ name?: unknown; html_url?: unknown }[]> => {
			const answer = await call(`Bearer ${token}`, { method: "GET",
				path: `/repos/${repository}/commits/${commit}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
				allow: [200], permission: "checks: read" });
			const runs = (answer.body as { check_runs?: unknown })?.check_runs;
			if (!Array.isArray(runs)) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `GET check runs on ${repository} answered without a list.`);
			return runs as { name?: unknown; html_url?: unknown }[];
		};
		const found = (await list()).find(run => run.name === name);
		if (found !== undefined) return textOf(found, "html_url");
		const created = await call(`Bearer ${token}`, { method: "POST", path: `/repos/${repository}/check-runs`, allow: [201, 422],
			permission: "checks: write", body: { name, head_sha: commit, status: "completed", conclusion: "success",
				output: { title: name, summary: `Acquit verified ${jobId} at ${commit}.` } } });
		if (created.status === 201) return textOf(created.body, "html_url");
		// A concurrent publish created the run: adopt it instead of posting a second one.
		const again = (await list()).find(run => run.name === name);
		if (again !== undefined) return textOf(again, "html_url");
		throw new GitHubAppError("GITHUB_HTTP_ERROR", `POST check runs on ${repository} answered 422 with no run named ${name}.`, { status: 422 });
	};

	const publishVerified = async (request: PublishRequest): Promise<PublishedPullRequest> => {
		const client = splitRepository(request.repository);
		const branch = verifiedBranch(request.jobId);
		const clientToken = await tokenFor(client.owner);
		let headOwner = client.owner;
		let headRepository = request.repository;
		try {
			await ensureBranch(request.repository, branch, request.sourceCommit, clientToken);
		} catch (error) {
			if (!(error instanceof GitHubAppError) || error.code !== "GITHUB_COMMIT_ABSENT") throw error;
			// The commit was pushed to the job's work fork: branch it there and open the pull request from the fork.
			headOwner = parsed.organization;
			headRepository = `${parsed.organization}/${workRepoName(request.repository, request.jobId)}`;
			await ensureBranch(headRepository, branch, request.sourceCommit, await tokenFor(headOwner));
		}
		const headToken = headOwner === client.owner ? clientToken : await tokenFor(headOwner);
		const pullRequest = await findOrOpenPullRequest(request, branch, headOwner, clientToken);
		const checkRunUrl = await findOrPostCheckRun(headRepository, request.sourceCommit, request.checkName, headToken, request.jobId);
		return { repository: request.repository, pullRequest, mergeCommit: request.sourceCommit, checkRunUrl };
	};

	// The port carries a request id. Every operation above is idempotent on the repository, ref, pull,
	// and check name, which is what GitHub gives this client to reconcile with, so nothing else is needed.
	return {
		async createWorkRepo(request) { return createWorkRepo(request); },
		async publishVerified(request) { return publishVerified(request); },
	};
}

export type GitHubCall = { readonly kind: "CREATE_WORK_REPO" | "PUBLISH_VERIFIED"; readonly jobId: JobId; readonly requestId: string };

export type FakeGitHubApp = GitHubAppPort & {
	readonly calls: readonly GitHubCall[];
	readonly workRepos: ReadonlyMap<JobId, WorkRepo>;
	readonly pullRequests: ReadonlyMap<JobId, PublishedPullRequest>;
};

/** The unit path and the development app. Deterministic, idempotent, and it records what it was asked to do. */
export function createFakeGitHubApp(options: { readonly organization?: string; readonly firstPullRequest?: number } = {}): FakeGitHubApp {
	const organization = options.organization ?? "acquit-forks";
	const calls: GitHubCall[] = [];
	const workRepos = new Map<JobId, WorkRepo>();
	const pullRequests = new Map<JobId, PublishedPullRequest>();
	let nextPullRequest = options.firstPullRequest ?? 13;
	return {
		calls, workRepos, pullRequests,
		async createWorkRepo(request, requestId) {
			calls.push({ kind: "CREATE_WORK_REPO", jobId: request.jobId, requestId });
			const existing = workRepos.get(request.jobId);
			if (existing) return existing;
			const repository = `${organization}/${workRepoName(request.repository, request.jobId)}`;
			const created: WorkRepo = { repository, remote: `https://github.com/${repository}.git`,
				branch: "main", commit: request.frozenCommit };
			workRepos.set(request.jobId, created);
			return created;
		},
		async publishVerified(request, requestId) {
			calls.push({ kind: "PUBLISH_VERIFIED", jobId: request.jobId, requestId });
			const existing = pullRequests.get(request.jobId);
			if (existing) return existing;
			const published: PublishedPullRequest = { repository: request.repository, pullRequest: nextPullRequest++,
				mergeCommit: request.sourceCommit, checkRunUrl: `https://github.com/${request.repository}/runs/${request.jobId}` };
			pullRequests.set(request.jobId, published);
			return published;
		},
	};
}

/** `invoice-app` plus the job id, so ten lanes never collide on one repository name. */
export function workRepoName(repository: string, jobId: JobId): string {
	const name = repository.split("/").at(-1) ?? repository;
	return `${name}-${jobId.replace(/^job_/, "")}`;
}

/** The branch the verified tree is pushed to on the client repository. */
export function verifiedBranch(jobId: JobId): string {
	return `acquit/${jobId}`;
}
