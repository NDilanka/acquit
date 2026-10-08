// The GitHub App boundary. The App is an operator item, so the deployment wires one of three ports:
// the fake for the unit path and development, the fail-fast adapter while the App is absent, or the
// App client once the operator provisions it. Nothing here ever waits on a network call it cannot make.

import { createPrivateKey, createSign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CommitSha, JobId } from "./ids.ts";
import { DEMO_CLIENT_REPOSITORY } from "./seed-data.ts";
import { boundedDetail } from "./verifier.ts";

// Every refusal that copies server text goes through the contract's one bounded, redacting helper.
export { boundedDetail };

export type GitHubAppConfig = {
	readonly appId: string;
	readonly privateKey: string;
	/** The organization that holds one pushed work repository per job. */
	readonly organization: string;
	readonly apiBase: string;
	/** Every request is bounded by this. A call that cannot answer in time refuses by name. */
	readonly timeoutMs: number;
	/**
	 * How long a publish waits for the client repository to take a commit pushed to the job's fork.
	 * GitHub exposes a fresh fork commit to the rest of the fork network only after a delay (live:
	 * up to ~30 s), and until then the ref write answers "Object does not exist".
	 */
	readonly convergenceMs: number;
	/** The gap between those attempts. */
	readonly convergenceStepMs: number;
};

export type GitHubAppConfigInput = Partial<Omit<GitHubAppConfig, "apiBase">> & { readonly apiBase?: string };

export class GitHubAppNotConfigured extends Error {
	readonly code = "GITHUB_APP_NOT_CONFIGURED";
	constructor(detail = "The GitHub App is not configured.") { super(detail); }
}

/** Every refusal the App client makes. The code is the name an operator acts on. */
export type GitHubFailureCode =
	// Permanent: a person or a fix clears it before a retry can work.
	| "GITHUB_APP_KEY_INVALID"
	| "GITHUB_INSTALLATION_MISSING"
	| "GITHUB_PERMISSION_MISSING"
	| "GITHUB_FORK_MISMATCH"
	| "GITHUB_REF_CONFLICT"
	| "GITHUB_COMMIT_ABSENT"
	| "GITHUB_NOT_FOUND"
	| "GITHUB_RESPONSE_INVALID"
	| "GITHUB_REQUEST_INVALID"
	// Transient: the same call can succeed later.
	| "GITHUB_RATE_LIMITED"
	| "GITHUB_TIMEOUT"
	| "GITHUB_NETWORK"
	// GitHub's catch-all. A 5xx is transient; every other status is permanent.
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

/** One client repository to fork: the deployment's source, and the name the fork takes in the organization. */
export type ClientRepoRequest = { readonly repository: string; readonly name: string };

/** One client repository to remove: the fork's own name, and the source it must be a fork of. */
export type ClientRepoDeleteRequest = { readonly repository: string; readonly source: string };

/** The fork a visitor's own jobs freeze. Its remote is derived, never stored. */
export type ClientRepo = { readonly repository: string; readonly remote: string };

/** What removing a visitor's repository found: this client's own fork, or a name already gone. */
export type ClientRepoRemoval = "DELETED" | "ABSENT";

/**
 * What judge mode needs: one disposable client repository per visitor, forked into the App's
 * organization, and removed with the visitor. The App alone makes and unmakes them: no personal access
 * token, and no repository this client did not create is ever adopted or deleted.
 */
export interface ClientRepoPort {
	/** Idempotent per name: a retry adopts this client's own fork instead of creating a second repository. */
	createClientRepo(request: ClientRepoRequest): Promise<ClientRepo>;
	/** Idempotent per name: a repository that is already gone is ABSENT, and one this client did not fork is refused. */
	deleteClientRepo(request: ClientRepoDeleteRequest): Promise<ClientRepoRemoval>;
}

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

export type MergeRequest = {
	readonly jobId: JobId;
	/** The repository that holds the pull request: the client's, as the contract froze it. */
	readonly repository: string;
	readonly pullRequest: number;
	/** The tree the verifier judged. The merge names it, so a moved head is refused instead of merged. */
	readonly mergeCommit: CommitSha;
};

/** What a merge answers: GitHub's commit on the base branch when it merged, and why it did not. */
export type MergeOutcome =
	| { readonly outcome: "MERGED"; readonly sha: CommitSha }
	| { readonly outcome: "UNKNOWN" }
	| { readonly outcome: "CONFLICT" };

/** What the money path's MERGE effect needs. */
export interface MergerPort {
	/**
	 * Idempotent per pull request: a retry reads the pull and adopts a merge that already landed. CONFLICT
	 * is a merge this client will not make, which a person resolves; a transient refusal is thrown.
	 */
	merge(request: MergeRequest, requestId: string): Promise<MergeOutcome>;
}

/**
 * What a caller outside this client's own operations needs: installation tokens, minted with the same
 * bounded, redacted, rate-limit-aware calls. The verifier's git fetch is one caller; the API's
 * work-repo route is the scoped one.
 */
export interface TokenPort {
	/**
	 * One token per owner and scope. With `repositories` the token is scoped to exactly those repository
	 * names and carries the least privilege a run and submit need; without it, the owner's own
	 * installation token. The scope is part of the cache key, so a token is never served for another.
	 */
	installationToken(owner: string, repositories?: readonly string[]): Promise<string>;
}

export interface GitHubAppPort extends WorkRepoPort, PublisherPort, MergerPort, TokenPort, ClientRepoPort {}

/** Boundary parse. A partial config is not an error here; it selects the fail-fast adapter. */
export function parseGitHubAppConfig(input: GitHubAppConfigInput | undefined): GitHubAppConfig | null {
	const appId = input?.appId?.trim() ?? "";
	const privateKey = input?.privateKey?.trim() ?? "";
	const organization = input?.organization?.trim() ?? "";
	if (!appId || !privateKey || !organization) return null;
	const timeout = Number(input?.timeoutMs);
	const convergence = Number(input?.convergenceMs);
	const step = Number(input?.convergenceStepMs);
	return { appId, privateKey, organization, apiBase: input?.apiBase?.trim() || "https://api.github.com",
		timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
		convergenceMs: Number.isFinite(convergence) && convergence >= 0 ? convergence : DEFAULT_CONVERGENCE_MS,
		convergenceStepMs: Number.isFinite(step) && step > 0 ? step : DEFAULT_CONVERGENCE_STEP_MS };
}

export function missingGitHubNames(input: GitHubAppConfigInput | undefined): readonly string[] {
	return [["GITHUB_APP_ID", input?.appId], ["GITHUB_APP_PRIVATE_KEY", input?.privateKey], ["GITHUB_APP_ORG", input?.organization]]
		.filter(([, value]) => !value?.trim()).map(([name]) => String(name));
}

/** Every call refuses immediately. It never starts a request it cannot authenticate. */
export function unconfiguredGitHubApp(detail = `Missing ${missingGitHubNames({}).join(", ")}.`): GitHubAppPort {
	const fail = (): never => { throw new GitHubAppNotConfigured(detail); };
	return { createWorkRepo: async () => fail(), publishVerified: async () => fail(), merge: async () => fail(),
		createClientRepo: async () => fail(), deleteClientRepo: async () => fail(), installationToken: async () => fail() };
}

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** A response body larger than this is refused instead of buffered. */
const MAX_BODY_BYTES = 1_048_576;

/** The live lag between a push to a fork and the fork network exposing the commit. */
const DEFAULT_CONVERGENCE_MS = 45_000;
const DEFAULT_CONVERGENCE_STEP_MS = 5_000;

/** Strict shapes for every caller-supplied name before it enters a URL. */
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function invalid(what: string, value: unknown): never {
	// A caller can hand this client anything, including a value that is not a string at all: the refusal
	// names what it got instead of throwing a TypeError from the middle of a URL.
	const shown = describe(value).slice(0, 60);
	throw new GitHubAppError("GITHUB_REQUEST_INVALID", `${what} "${shown}" is not a name this client will put in a URL.`);
}

/** Anything at all, as a short string. A value with no primitive form is named by its type instead of thrown. */
function describe(value: unknown): string {
	try { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
	catch { return typeof value; }
}

const checkedOwner = (owner: unknown): string => typeof owner === "string" && OWNER_NAME.test(owner) ? owner : invalid("The owner", owner);
const checkedRepositoryName = (name: unknown): string => typeof name === "string" && REPOSITORY_NAME.test(name) ? name : invalid("The repository name", name);
const checkedCommit = (commit: unknown): CommitSha => typeof commit === "string" && COMMIT_SHA.test(commit) ? commit as CommitSha : invalid("The commit", commit);
const checkedCheckName = (name: unknown): string => typeof name === "string" && name.trim().length > 0 ? name : invalid("The check name", name);

/**
 * The repository names a mint is scoped to, validated at the boundary. Absent means the owner's own
 * installation token; an empty scope is refused rather than widened, because a caller that named no
 * repository must not receive the token for all of them.
 */
function tokenScope(repositories: readonly string[] | undefined): readonly string[] | null {
	if (repositories === undefined) return null;
	if (!Array.isArray(repositories) || repositories.length === 0) invalid("The repository scope", repositories);
	return repositories.map(name => checkedRepositoryName(name));
}

/**
 * The deployment's client repository, read at the config boundary. OpenJob freezes it into the
 * contract, and the work-repo fork, the judge, and the publisher read it from there. Absent means the
 * demo fixture; a malformed value refuses by the name an operator set, never by its own text.
 */
export function parseClientRepository(value: string | undefined): string {
	const text = value?.trim() ?? "";
	if (!text) return DEMO_CLIENT_REPOSITORY;
	const [owner, name, ...rest] = text.split("/");
	if (rest.length > 0 || owner === undefined || name === undefined || !OWNER_NAME.test(owner) || !REPOSITORY_NAME.test(name)) {
		throw new Error(`Invalid configuration: ACQUIT_CLIENT_REPOSITORY. Give an owner/repo such as ${DEMO_CLIENT_REPOSITORY}.`);
	}
	return `${owner}/${name}`;
}

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

type Answer = { readonly status: number; readonly body: unknown; readonly headers: Headers };
type Call = { readonly method: string; readonly path: string; readonly body?: unknown;
	readonly allow: readonly number[]; readonly permission?: string };

/** Reads a response body, refusing one larger than the cap instead of buffering it. */
async function readBounded(response: Response, spec: Call): Promise<string> {
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `${spec.method} ${spec.path} answered with more than ${MAX_BODY_BYTES} bytes.`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The durable ownership marker for a repository this client forked: a fork of exactly this source, under exactly this name. */
function isOurFork(record: unknown, repository: string, source: string): boolean {
	const shape = record as { full_name?: unknown; fork?: unknown; parent?: unknown } | null;
	if (shape === null || typeof shape !== "object") return false;
	if (String(shape.full_name ?? "").toLowerCase() !== repository.toLowerCase()) return false;
	if (shape.fork !== true) return false;
	const parent = (shape.parent as { full_name?: unknown } | null | undefined)?.full_name;
	return String(parent ?? "").toLowerCase() === source.toLowerCase();
}

/** One token per owner and scope, refreshed shortly before GitHub expires it. */
const REFRESH_MARGIN_MS = 60_000;

/** The least privilege a run and submit exercise on their work repo: read it and push to it. */
const SCOPED_TOKEN_PERMISSIONS = { contents: "write", metadata: "read" } as const;

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
	/** Server text, bounded and redacted before it is copied anywhere. */
	const said = (body: unknown): string => boundedDetail(textOf(body, "message") ?? "");
	/** GitHub's refusal text: the top-level message plus every entry's message. */
	const refusalText = (body: unknown): string => {
		const messages = [textOf(body, "message") ?? ""];
		const errors = body !== null && typeof body === "object" ? (body as { errors?: unknown }).errors : undefined;
		if (Array.isArray(errors)) for (const item of errors) messages.push(textOf(item, "message") ?? "");
		return messages.join(" ");
	};
	/** GitHub's wording for a ref write naming an object the repository does not have. */
	const saysObjectAbsent = (body: unknown): boolean => /object does not exist/i.test(refusalText(body));
	/**
	 * The two texts a create answers while a fork's object has not reached the client repository yet:
	 * "Object does not exist", and "Reference update failed" (measured live: the identical POST answered
	 * 201 about two minutes later). Only the create reads the second text; the branch move keeps the
	 * narrower match, because a move refused for any other reason is a refusal, never a fork fallback.
	 */
	const saysCreateNotYetVisible = (body: unknown): boolean => saysObjectAbsent(body) || /reference update failed/i.test(refusalText(body));

	const refusal = (status: number, body: unknown, headers: Headers, spec: Call): GitHubAppError => {
		const detail = `${spec.method} ${spec.path} answered ${status}${said(body) ? `: ${said(body)}` : "."}`;
		const accepted = (headers.get("x-accepted-github-permissions") ?? "").split(",").map(item => item.trim()).filter(Boolean);
		const permission = accepted[0] ?? spec.permission ?? null;
		const missing = permission === null ? "" : ` Missing permission: ${boundedDetail(permission)}.`;
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
		let response: Response | null = null;
		let text: string;
		try {
			response = await fetch(`${parsed.apiBase}${spec.path}`, {
				method: spec.method,
				headers: { accept: "application/vnd.github+json", authorization, "x-github-api-version": "2022-11-28",
					"user-agent": `acquit-verifier/${parsed.appId}`, ...(spec.body === undefined ? {} : { "content-type": "application/json" }) },
				body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
				signal: AbortSignal.timeout(parsed.timeoutMs),
				redirect: "error",
			});
			text = await readBounded(response, spec);
		} catch (error) {
			if (error instanceof GitHubAppError) throw error;
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new GitHubAppError("GITHUB_TIMEOUT", `${spec.method} ${spec.path} timed out after ${parsed.timeoutMs} ms.`);
			}
			const where = response === null ? `could not reach ${parsed.apiBase}` : `answered ${response.status} with a body that could not be read`;
			throw new GitHubAppError("GITHUB_NETWORK", `${spec.method} ${spec.path} ${where}: ${boundedDetail(messageOf(error))}`);
		}
		let body: unknown = null;
		if (text.trim() !== "") {
			try { body = JSON.parse(text); }
			catch { throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `${spec.method} ${spec.path} answered ${response.status} with a body that is not JSON.`, { status: response.status }); }
		}
		if (!spec.allow.includes(response.status)) throw refusal(response.status, body, response.headers, spec);
		return { status: response.status, body, headers: response.headers };
	};

	const appCall = (spec: Call): Promise<Answer> => call(`Bearer ${appJwt(parsed.appId, parsed.privateKey, Date.now())}`, spec);

	const installationsOf = async (): Promise<readonly { readonly id: number; readonly account: string }[]> => {
		installations ??= (async () => {
			const found: { id: number; account: string }[] = [];
			for (let page = 1; page <= 10; page++) {
				const answer = await appCall({ method: "GET", path: `/app/installations?per_page=100&page=${page}`, allow: [200] });
				// GET /app/installations answers with a bare array, never a wrapper object.
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

	const tokenFor = async (owner: string, repositories?: readonly string[]): Promise<string> => {
		const scope = tokenScope(repositories);
		// The scope is part of the key: a token minted for one repository is never handed out for
		// another one, or for the whole owner.
		const key = scope === null ? owner : `${owner}\u0000${scope.join("\u0000")}`;
		const cached = tokens.get(key);
		if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cached.token;
		const running = minting.get(key);
		if (running) return running;
		const mint = (async () => {
			const list = await installationsOf();
			const installation = list.find(item => item.account.toLowerCase() === owner.toLowerCase());
			if (installation === undefined) {
				// The operator can install the App while this process runs, so the next call re-reads the list.
				installations = null;
				throw new GitHubAppError("GITHUB_INSTALLATION_MISSING", `The App has no installation on ${owner}. Install the App on ${owner} before this call.`);
			}
			// A scoped mint names the repositories and the permissions; GitHub refuses a repository the
			// installation cannot see yet, which is how a work repo before its funding answers.
			const answer = await appCall({ method: "POST", path: `/app/installations/${installation.id}/access_tokens`, allow: [201],
				...(scope === null ? {} : { body: { repositories: scope, permissions: SCOPED_TOKEN_PERMISSIONS } }) });
			const token = textOf(answer.body, "token");
			if (token === null) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `The installation token for ${owner} carried no token.`);
			const expiresAt = Date.parse(textOf(answer.body, "expires_at") ?? "");
			tokens.set(key, { token, expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : 0 });
			return token;
		})();
		minting.set(key, mint);
		try { return await mint; } finally { minting.delete(key); }
	};

	const splitRepository = (repository: unknown): { readonly owner: string; readonly name: string } => {
		if (typeof repository !== "string") invalid("The repository", repository);
		const [owner, name, ...rest] = repository.split("/");
		if (rest.length > 0 || owner === undefined || name === undefined) invalid("The repository", repository);
		return { owner: checkedOwner(owner), name: checkedRepositoryName(name) };
	};

	const readRef = async (repository: string, branch: string, token: string): Promise<string | null> => {
		const answer = await call(`Bearer ${token}`, { method: "GET", path: `/repos/${repository}/git/ref/heads/${branch}`,
			allow: [200, 404, 409], permission: "contents: read" });
		// 404 is a ref that is not there; 409 is "Git Repository is empty.", so there is no ref to compare either.
		if (answer.status !== 200) return null;
		const sha = textOf((answer.body as { object?: unknown })?.object, "sha");
		if (sha === null) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `The ref ${branch} on ${repository} carried no object sha.`);
		return sha;
	};

	const createRef = async (repository: string, branch: string, commit: CommitSha, token: string): Promise<void> => {
		const spec: Call = { method: "POST", path: `/repos/${repository}/git/refs`, allow: [201, 409, 422],
			permission: "contents: write", body: { ref: `refs/heads/${branch}`, sha: commit } };
		const answer = await call(`Bearer ${token}`, spec);
		if (answer.status === 201) return;
		// Either a concurrent writer won the ref or the write was refused. The ref read decides which.
		const existing = await readRef(repository, branch, token);
		if (existing === commit) return;
		if (existing !== null) throw new GitHubAppError("GITHUB_REF_CONFLICT", `${repository} has ${branch} at ${existing}, not ${commit}.`, { status: answer.status });
		// As in the branch move above: only the two texts a not-yet-propagated object produces mean this
		// repository cannot carry the commit and the fork can. Any other 409/422 is a refusal on another
		// rule, and reading it as an absent object would burn the convergence budget and then ask the fork
		// for a pull request GitHub refuses for that other reason. GitHub's own text is the refusal.
		if (saysCreateNotYetVisible(answer.body)) {
			throw new GitHubAppError("GITHUB_COMMIT_ABSENT", `${repository} cannot take ${branch} at ${commit}: ${said(answer.body) || "the object is not in this repository"}.`, { status: answer.status });
		}
		throw refusal(answer.status, answer.body, answer.headers, spec);
	};

	const ensureBranch = async (repository: string, branch: string, commit: CommitSha, token: string): Promise<void> => {
		const existing = await readRef(repository, branch, token);
		if (existing === null) { await createRef(repository, branch, commit, token); return; }
		if (existing === commit) return;
		// This branch is written only by the publisher. A run is single-flight only while it holds the
		// job's slot: a run that outlives runEndsAt can still publish after the job reclaimed the slot,
		// so a late write and the next run can race this ref. Either way a ref at another commit is a
		// publish that did not finish: the judged commit is the target state, and the retry after that
		// failure converges instead of refusing the job forever.
		const spec: Call = { method: "PATCH", path: `/repos/${repository}/git/refs/heads/${branch}`, allow: [200, 422],
			permission: "contents: write", body: { sha: commit, force: true } };
		const answer = await call(`Bearer ${token}`, spec);
		if (answer.status === 200) return;
		// Only "Object does not exist" means the fork can carry the commit instead. Any other 422 is a
		// refusal on another rule, and reading it as an absent object would branch the fork and ask for
		// a pull request GitHub refuses for that other reason. A 409 is not allowed and refuses below.
		if (saysObjectAbsent(answer.body)) {
			throw new GitHubAppError("GITHUB_COMMIT_ABSENT",
				`${repository} cannot take ${branch} at ${commit}: ${said(answer.body) || "the object is not in this repository"}.`, { status: 422 });
		}
		throw refusal(422, answer.body, answer.headers, spec);
	};

	/** Creates this repository's fork. Answers "created" only when this call's 202 named the repository it asked for. */
	const forkInto = async (organization: string, repository: string, name: string,
		source: { readonly owner: string; readonly name: string }, orgToken: string): Promise<"created" | "existed"> => {
		// The target org's installation makes the fork: GitHub checks administration on the org plus the App's
		// read access to the source, and it refuses the source installation's token.
		const spec: Call = { method: "POST", path: `/repos/${source.owner}/${source.name}/forks`, allow: [202, 403, 422],
			permission: "administration: write", body: { organization, name, default_branch_only: false } };
		const answer = await call(`Bearer ${orgToken}`, spec);
		if (answer.status === 202) {
			const created = textOf(answer.body, "full_name");
			if (created === null) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `POST ${spec.path} answered 202 without a repository name.`, { status: 202 });
			if (created.toLowerCase() !== repository.toLowerCase()) {
				// GitHub ignored the requested name. This client never renames a repository it did not name itself.
				throw new GitHubAppError("GITHUB_FORK_MISMATCH", `The fork answered ${created}, not ${repository}. Nothing was renamed or moved.`, { status: 202 });
			}
			return "created";
		}
		// A taken name is GitHub's "already exists" answer. The repository at the name decides what happens next.
		if (/already exists/i.test(said(answer.body))) return "existed";
		if (answer.status === 403) throw refusal(403, answer.body, answer.headers, spec);
		throw new GitHubAppError("GITHUB_HTTP_ERROR", `POST ${spec.path} answered 422: ${said(answer.body) || "the fork was refused"}.`, { status: 422 });
	};

	const createWorkRepo = async (request: WorkRepoRequest): Promise<WorkRepo> => {
		const organization = checkedOwner(parsed.organization);
		const source = splitRepository(request.repository);
		const commit = checkedCommit(request.frozenCommit);
		const name = workRepoName(request.repository, request.jobId);
		const repository = `${organization}/${name}`;
		// The org installation answers for everything inside the org, so its absence refuses before any write.
		const orgToken = await tokenFor(organization);
		const readRepo = () => call(`Bearer ${orgToken}`, { method: "GET", path: `/repos/${repository}`, allow: [200, 404], permission: "administration: write" });
		const found = await readRepo();
		const outcome = found.status === 200 ? "existed" : await forkInto(organization, repository, name, source, orgToken);
		if (outcome === "existed") {
			// Adopt the repository only when it carries the ownership marker: the exact fork parent plus the
			// job-unique name. A repository this client did not create is never moved, and never written to.
			const record = found.status === 200 ? found.body : (await readRepo()).body;
			if (!isOurFork(record, repository, request.repository)) {
				throw new GitHubAppError("GITHUB_FORK_MISMATCH", `${repository} is not the fork of ${request.repository} named ${name} that this job creates. Nothing was moved.`);
			}
		}
		const existing = await readRef(repository, WORK_REPO_BRANCH, orgToken);
		if (existing === null) await createRef(repository, WORK_REPO_BRANCH, commit, orgToken);
		else if (existing !== commit) {
			// This repository is the job's own fork, so the frozen commit is its target state: a retry after a
			// failed move converges here instead of refusing the repository this client created.
			await call(`Bearer ${orgToken}`, { method: "PATCH", path: `/repos/${repository}/git/refs/heads/${WORK_REPO_BRANCH}`, allow: [200],
				permission: "contents: write", body: { sha: commit, force: true } });
		}
		return { repository, remote: `https://github.com/${repository}.git`, branch: WORK_REPO_BRANCH, commit };
	};

	/**
	 * One disposable client repository per visitor: the deployment's source forked under the visitor's
	 * own name in the organization. A retry adopts this client's own fork and never creates a second
	 * repository; a name some other repository already holds is refused instead of written over.
	 */
	const createClientRepo = async (request: ClientRepoRequest): Promise<ClientRepo> => {
		const organization = checkedOwner(parsed.organization);
		const source = splitRepository(request.repository);
		// The visitor's name is a repository name, never a path: it is refused before it enters a URL.
		const name = checkedRepositoryName(request.name);
		const repository = `${organization}/${name}`;
		const orgToken = await tokenFor(organization);
		const readRepo = () => call(`Bearer ${orgToken}`, { method: "GET", path: `/repos/${repository}`, allow: [200, 404], permission: "administration: write" });
		const found = await readRepo();
		if (found.status !== 200) {
			const outcome = await forkInto(organization, repository, name, source, orgToken);
			if (outcome === "existed") {
				// The name was taken between the read and the fork. Read it once more and adopt it only when it
				// carries the ownership marker: a repository this client did not fork is never adopted.
				const raced = await readRepo();
				if (!isOurFork(raced.body, repository, request.repository)) {
					throw new GitHubAppError("GITHUB_FORK_MISMATCH", `${repository} is not the fork of ${request.repository} named ${name} that this visitor creates. Nothing was moved.`);
				}
			}
		} else if (!isOurFork(found.body, repository, request.repository)) {
			// The same ownership marker the work repo carries. A visitor's name is not a claim on someone
			// else's repository: a mismatch refuses by name and moves nothing.
			throw new GitHubAppError("GITHUB_FORK_MISMATCH", `${repository} is not the fork of ${request.repository} named ${name} that this visitor creates. Nothing was moved.`);
		}
		return { repository, remote: `https://github.com/${repository}.git` };
	};

	/**
	 * Removes one visitor's own fork, with the same ownership marker the create writes: the fork of
	 * exactly this source, under exactly this name. A name this client did not fork is refused and never
	 * deleted, and one that is already gone is ABSENT, so a retried sweep converges instead of failing
	 * on work it already did.
	 */
	const deleteClientRepo = async (request: ClientRepoDeleteRequest): Promise<ClientRepoRemoval> => {
		const target = splitRepository(request.repository);
		splitRepository(request.source);
		const organization = checkedOwner(parsed.organization);
		if (target.owner.toLowerCase() !== organization.toLowerCase()) {
			throw new GitHubAppError("GITHUB_FORK_MISMATCH", `${request.repository} is not a repository in ${organization}. Nothing was deleted.`);
		}
		const orgToken = await tokenFor(organization);
		const found = await call(`Bearer ${orgToken}`, { method: "GET", path: `/repos/${request.repository}`, allow: [200, 404], permission: "administration: write" });
		if (found.status === 404) return "ABSENT";
		if (!isOurFork(found.body, request.repository, request.source)) {
			throw new GitHubAppError("GITHUB_FORK_MISMATCH", `${request.repository} is not the fork of ${request.source} this deployment created. Nothing was deleted.`);
		}
		await call(`Bearer ${orgToken}`, { method: "DELETE", path: `/repos/${request.repository}`, allow: [204], permission: "administration: write" });
		return "DELETED";
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
		// Nothing adopted the head, so GitHub's own text is the only account of the refusal. A live
		// PUBLISH_FAILED has to carry it: the status alone names no fixable cause.
		throw new GitHubAppError("GITHUB_HTTP_ERROR",
			`POST pulls on ${request.repository} answered 422${said(created.body) ? `: ${said(created.body)}` : ""} with no pull request for ${head}.`, { status: 422 });
	};

	const findOrPostCheckRun = async (repository: string, commit: CommitSha, name: string, token: string, jobId: JobId): Promise<string | null> => {
		const list = async (): Promise<{ name?: unknown; external_id?: unknown; html_url?: unknown }[]> => {
			const answer = await call(`Bearer ${token}`, { method: "GET",
				path: `/repos/${repository}/commits/${commit}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
				allow: [200], permission: "checks: read" });
			const runs = (answer.body as { check_runs?: unknown })?.check_runs;
			if (!Array.isArray(runs)) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `GET check runs on ${repository} answered without a list.`);
			return runs as { name?: unknown; external_id?: unknown; html_url?: unknown }[];
		};
		// GitHub keeps more than one run per name, so the job's external id is what makes this idempotent.
		const found = (await list()).find(run => run.name === name && run.external_id === jobId);
		if (found !== undefined) return textOf(found, "html_url");
		const created = await call(`Bearer ${token}`, { method: "POST", path: `/repos/${repository}/check-runs`, allow: [201],
			permission: "checks: write", body: { name, head_sha: commit, external_id: jobId, status: "completed", conclusion: "success",
				output: { title: name, summary: `Acquit verified ${jobId} at ${commit}.` } } });
		return textOf(created.body, "html_url");
	};

	/**
	 * Points the client repository's verified branch at the judged commit, waiting out GitHub's own
	 * propagation. A commit the submitter pushed to the job's fork reaches the fork network's other
	 * repositories only after the daemon has indexed the push; until then every ref write naming it
	 * answers "Object does not exist". The client installation cannot create a cross-repository pull
	 * request in that window either, because it cannot reach the fork (the live API answered 422
	 * "Validation Failed: head invalid" for a minute, and the fork owner's installation 403 from the
	 * base repository), so waiting is what converges. Bounded: a commit that never arrives answers
	 * false and the caller falls back to the fork.
	 */
	const branchClientRepository = async (repository: string, branch: string, commit: CommitSha, token: string): Promise<boolean> => {
		const deadline = Date.now() + parsed.convergenceMs;
		for (;;) {
			try {
				await ensureBranch(repository, branch, commit, token);
				return true;
			} catch (error) {
				if (!(error instanceof GitHubAppError) || error.code !== "GITHUB_COMMIT_ABSENT") throw error;
				const remaining = deadline - Date.now();
				if (remaining <= 0) return false;
				await sleep(Math.min(parsed.convergenceStepMs, remaining));
			}
		}
	};

	const publishVerified = async (request: PublishRequest): Promise<PublishedPullRequest> => {
		const organization = checkedOwner(parsed.organization);
		const client = splitRepository(request.repository);
		const commit = checkedCommit(request.sourceCommit);
		const checkName = checkedCheckName(request.checkName);
		const branch = verifiedBranch(request.jobId);
		const clientToken = await tokenFor(client.owner);
		let headOwner = client.owner;
		let headRepository = request.repository;
		if (!await branchClientRepository(request.repository, branch, commit, clientToken)) {
			// The commit is on the job's work fork and the client repository never took it: branch the
			// fork and ask for the pull request from there. GitHub's refusal names the rule it applies.
			headOwner = organization;
			headRepository = `${organization}/${workRepoName(request.repository, request.jobId)}`;
			await ensureBranch(headRepository, branch, commit, await tokenFor(headOwner));
		}
		const headToken = headOwner === client.owner ? clientToken : await tokenFor(headOwner);
		const pullRequest = await findOrOpenPullRequest(request, branch, headOwner, clientToken);
		const checkRunUrl = await findOrPostCheckRun(headRepository, commit, checkName, headToken, request.jobId);
		return { repository: request.repository, pullRequest, mergeCommit: commit, checkRunUrl };
	};

	// The port carries a request id. Every operation above is idempotent on the repository, ref, pull,
	// and the check run's external id, which is what GitHub gives this client to reconcile with, so
	// nothing else is needed.
	/**
	 * Merges the pull request the verifier opened. The pull is read first, so a merge that already landed
	 * is adopted rather than attempted again, and the merge names the judged commit so a head that moved
	 * is refused by GitHub instead of merged. The answer carries the commit the merge landed on either way.
	 */
	const merge = async (request: MergeRequest): Promise<MergeOutcome> => {
		const client = splitRepository(request.repository);
		const commit = checkedCommit(request.mergeCommit);
		if (!Number.isSafeInteger(request.pullRequest) || request.pullRequest <= 0) invalid("The pull request", request.pullRequest);
		const token = await tokenFor(client.owner);
		/** The pull's immutable head, and the commit GitHub made on the base branch when it merged.
		 * `merge_commit_sha` is the commit created with merge_method "merge", so it is never equal to the
		 * judged head the merge named. */
		const read = async (): Promise<{ readonly merged: boolean; readonly head: string | null; readonly state: string | null; readonly mergeCommit: string | null }> => {
			const answer = await call(`Bearer ${token}`, { method: "GET", path: `/repos/${request.repository}/pulls/${request.pullRequest}`,
				allow: [200], permission: "pull_requests: read" });
			const body = answer.body as { readonly merged?: unknown; readonly head?: unknown; readonly state?: unknown; readonly merge_commit_sha?: unknown } | null;
			return { merged: body?.merged === true, head: textOf(body?.head, "sha"), state: textOf(body, "state"),
				mergeCommit: textOf(body, "merge_commit_sha") };
		};
		/** The commit the merge landed on. An answer that names none is a response this client will not read as MERGED. */
		const landedOn = (named: string | null): CommitSha => {
			if (named === null || !COMMIT_SHA.test(named)) throw new GitHubAppError("GITHUB_RESPONSE_INVALID",
				"GitHub answered a landed merge without naming the commit it made.");
			return named as CommitSha;
		};
		const settled = (pull: { readonly merged: boolean; readonly head: string | null; readonly mergeCommit: string | null }): MergeOutcome | null =>
			pull.merged ? pull.head === commit ? { outcome: "MERGED", sha: landedOn(pull.mergeCommit) } : { outcome: "CONFLICT" } : null;
		const before = await read();
		const already = settled(before);
		if (already !== null) return already;
		if (before.state !== "open") return { outcome: "CONFLICT" };
		try {
			const answer = await call(`Bearer ${token}`, { method: "PUT", path: `/repos/${request.repository}/pulls/${request.pullRequest}/merge`,
				allow: [200], permission: "contents: write", body: { sha: commit, merge_method: "merge" } });
			return { outcome: "MERGED", sha: landedOn(textOf(answer.body, "sha")) };
		} catch (error) {
			// GitHub refuses a merge it will not make. A concurrent writer may have merged it first, so the
			// pull is read once more; anything else that is not a refusal of this merge stays transient.
			const after = await read().catch(() => null);
			const raced = after === null ? null : settled(after);
			if (raced !== null) return raced;
			if (error instanceof GitHubAppError && [405, 409, 422].includes(error.status ?? 0)) return { outcome: "CONFLICT" };
			throw error;
		}
	};
	return {
		async createWorkRepo(request) { return createWorkRepo(request); },
		async createClientRepo(request) { return createClientRepo(request); },
		async deleteClientRepo(request) { return deleteClientRepo(request); },
		async publishVerified(request) { return publishVerified(request); },
		async merge(request) { return merge(request); },
		async installationToken(owner, repositories) { return tokenFor(checkedOwner(owner), repositories); },
	};
}

export type GitHubCall = { readonly kind: "CREATE_WORK_REPO" | "PUBLISH_VERIFIED" | "MERGE"; readonly jobId: JobId; readonly requestId: string };

export type FakeGitHubApp = GitHubAppPort & {
	readonly calls: readonly GitHubCall[];
	readonly workRepos: ReadonlyMap<JobId, WorkRepo>;
	readonly clientRepos: ReadonlyMap<string, ClientRepo>;
	readonly pullRequests: ReadonlyMap<JobId, PublishedPullRequest>;
};

/** The unit path and the development app. Deterministic, idempotent, and it records what it was asked to do. */
export function createFakeGitHubApp(options: { readonly organization?: string; readonly firstPullRequest?: number } = {}): FakeGitHubApp {
	const organization = options.organization ?? "acquit-forks";
	const calls: GitHubCall[] = [];
	const workRepos = new Map<JobId, WorkRepo>();
	const clientRepos = new Map<string, ClientRepo>();
	const pullRequests = new Map<JobId, PublishedPullRequest>();
	let nextPullRequest = options.firstPullRequest ?? 13;
	return {
		calls, workRepos, pullRequests, clientRepos,
		async installationToken(owner, repositories) {
			const scope = tokenScope(repositories);
			return `fake-installation-token-${checkedOwner(owner)}${scope === null ? "" : `-${scope.join("+")}`}`;
		},
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
		async createClientRepo(request) {
			// One fork per name, the same rule the real client keeps: a second call adopts the first fork.
			const existing = clientRepos.get(request.name);
			if (existing !== undefined) return existing;
			const repository = `${organization}/${request.name}`;
			const created: ClientRepo = { repository, remote: `https://github.com/${repository}.git` };
			clientRepos.set(request.name, created);
			return created;
		},
		async deleteClientRepo(request) {
			// Only a fork this fake made is removed, and a name it never made is already gone.
			const name = request.repository.split("/").at(-1) ?? request.repository;
			if (!clientRepos.has(name)) return "ABSENT";
			clientRepos.delete(name);
			return "DELETED";
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
		async merge(request, requestId) {
			calls.push({ kind: "MERGE", jobId: request.jobId, requestId });
			const published = pullRequests.get(request.jobId);
			if (!published) return { outcome: "CONFLICT" };
			// The same rule the real client applies: only the judged tree merges, and only once. The fake
			// fast-forwards the base branch, so the commit it lands on is the published one.
			if (published.pullRequest !== request.pullRequest) return { outcome: "CONFLICT" };
			return published.mergeCommit === request.mergeCommit ? { outcome: "MERGED", sha: published.mergeCommit } : { outcome: "CONFLICT" };
		},
	};
}

/** `invoice-app` plus the job id, so ten lanes never collide on one repository name. */
export function workRepoName(repository: string, jobId: JobId): string {
	if (typeof repository !== "string" || typeof jobId !== "string") invalid("The work repository name", `${describe(repository)}-${describe(jobId)}`);
	const name = repository.split("/").at(-1) ?? repository;
	const full = `${name}-${jobId.replace(/^job_/, "")}`;
	return REPOSITORY_NAME.test(full) ? full : invalid("The work repository name", full);
}

/** The branch the verified tree is pushed to on the client repository. */
export function verifiedBranch(jobId: JobId): string {
	if (typeof jobId !== "string") invalid("The verified branch", jobId);
	const branch = `acquit/${jobId}`;
	return BRANCH_NAME.test(branch) ? branch : invalid("The verified branch", branch);
}
