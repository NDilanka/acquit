// The App client and the fake answer the same port, so one set of assertions runs against both.
// The stub-only tests pin the wire behaviour the client owns: RS256 claims, header auth, one
// installation token per owner, idempotent adopt-or-create, and the named refusals.

import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createFakeGitHubApp, createGitHubApp, workRepoName } from "../src/github.ts";
import type { GitHubAppPort } from "../src/github.ts";
import type { CommitSha, JobId } from "../src/ids.ts";

const FROZEN = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const HEAD = "b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9";
const SUBMITTED = "c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1";
/** The commit GitHub creates when a pull request merges with merge_method "merge". */
const MERGED = "d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1";
const CLIENT = "NDilanka/invoice-app";
const CLIENT_OWNER = "NDilanka";
const ORG = "acquit-forks";
const WORK_REPO = `${ORG}/invoice-app-7Q2K`;
const JOB = "job_7Q2K" as JobId;
const OTHER_JOB = "job_8Z3P" as JobId;
const CHECK_NAME = "Acquit verifier";
const APP_ID = "4242";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }) as unknown as { publicKey: string; privateKey: string };
const CONFIG = { appId: APP_ID, privateKey, organization: ORG, timeoutMs: 5_000, convergenceMs: 150, convergenceStepMs: 50 };
const workRepoRequest = { jobId: JOB, repository: CLIENT, frozenCommit: FROZEN };
const publishRequest = { jobId: JOB, repository: CLIENT, sourceCommit: FROZEN, checkName: CHECK_NAME };

type Refusal = { readonly code: string; readonly status: number | null; readonly permission: string | null; readonly detail: string };

/** The named refusal a call makes, read as the port's caller sees it. */
async function refusal(work: Promise<unknown>): Promise<Refusal> {
	try {
		await work;
	} catch (error) {
		const shape = error as { code?: unknown; status?: unknown; permission?: unknown; message?: unknown };
		return { code: String(shape.code ?? "NO_CODE"), status: typeof shape.status === "number" ? shape.status : null,
			permission: typeof shape.permission === "string" ? shape.permission : null, detail: String(shape.message ?? "") };
	}
	assert.fail("expected the call to refuse by name");
}

type StubRepo = { id: number; full_name: string; name: string; owner: string; default_branch: string; fork: boolean;
	parent: { full_name: string } | null };
type StubPull = { number: number; head: string; branch: string; state: string; title: string; body: string;
	merged: boolean; merge_commit_sha: string | null };
type StubCheck = { repo: string; id: number; name: string; head_sha: string; external_id: string | null; html_url: string };
type StubRequest = { readonly method: string; readonly path: string; readonly authorization: string; readonly body: unknown };
type StubRefusal = { readonly method: string; readonly path: string; readonly status: number; readonly message: string;
	readonly headers: Record<string, string>; readonly once: boolean };

type Stub = {
	readonly url: string;
	readonly state: {
		readonly repos: Map<string, StubRepo>;
		readonly refs: Map<string, string>;
		readonly commits: Map<string, Set<string>>;
		/** Commits a repository can take only after this many refused ref writes, as a fresh fork push is. */
		readonly propagating: Map<string, { remaining: number; message: string }>;
		readonly pulls: StubPull[];
		readonly checks: StubCheck[];
		/** Mutable, like the operator installing the App while the process runs. */
		readonly installations: { id: number; account: string }[];
		readonly mints: { readonly owner: string; readonly token: string }[];
		readonly requests: StubRequest[];
		readonly forks: string[];
	};
	seed(repository: string, commits: readonly string[], refs: Record<string, string>): void;
	refuse(refusal: { method: string; path: string; status: number; message?: string;
		headers?: Record<string, string>; once?: boolean }): void;
	/** The next fork answers 202 with this full_name instead of the requested one. */
	forkAs(name: string | null): void;
	/** The repository takes this commit only after this many refused ref writes, the way GitHub exposes
	 * a fresh fork push to the rest of the fork network after a delay. `message` is the wording those
	 * refusals carry: the live create answered both of the texts a late fork commit produces. */
	propagate(repository: string, sha: string, afterRefusals: number, message?: string): void;
	hang(path: string): void;
	close(): Promise<void>;
};

/** A local stand-in for api.github.com: it verifies the App JWT, mints tokens, and keeps repo state. */
async function createGitHubStub(options: { readonly appId: string; readonly publicKey: string;
	readonly installations: readonly { readonly id: number; readonly account: string }[] }): Promise<Stub> {
	const state = { repos: new Map<string, StubRepo>(), refs: new Map<string, string>(), commits: new Map<string, Set<string>>(),
		propagating: new Map<string, { remaining: number; message: string }>(), pulls: [] as StubPull[], checks: [] as StubCheck[],
		installations: [...options.installations], mints: [] as { owner: string; token: string }[], requests: [] as StubRequest[],
		forks: [] as string[] };
	const refusals: StubRefusal[] = [];
	const hangs: string[] = [];
	let forkAs: string | null = null;
	const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
		response.writeHead(status, { "content-type": "application/json", ...headers });
		response.end(JSON.stringify(body));
	};
	const verifyJwt = (token: string): boolean => {
		const [header, payload, signature] = token.split(".");
		if (!header || !payload || !signature) return false;
		try {
			const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: string; exp?: number };
			if (JSON.parse(Buffer.from(header, "base64url").toString("utf8")).alg !== "RS256") return false;
			if (claims.iss !== options.appId || (claims.exp ?? 0) < Date.now() / 1000) return false;
			return createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(options.publicKey, Buffer.from(signature, "base64url"));
		} catch { return false; }
	};
	const authorize = (authorization: string): { readonly kind: "app" } | { readonly kind: "installation"; readonly owner: string } | null => {
		if (!authorization.startsWith("Bearer ")) return null;
		const value = authorization.slice("Bearer ".length);
		if (value.split(".").length === 3) return verifyJwt(value) ? { kind: "app" } : null;
		const minted = state.mints.find(item => item.token === value);
		return minted === undefined ? null : { kind: "installation", owner: minted.owner };
	};
	const segmentsOf = (path: string): string[] => path.split("?")[0]!.split("/").filter(Boolean);
	/** A ref write naming an object the repository does not have yet, or the wording it answers. A
	 * propagating commit becomes present after the refusals the test asked for, the way GitHub indexes
	 * a fresh fork push. */
	const commitMissing = (repository: string, sha: string): { readonly message: string } | null => {
		const key = `${repository}:${sha}`;
		const arriving = state.propagating.get(key);
		if (arriving !== undefined) {
			if (arriving.remaining > 0) { arriving.remaining -= 1; return { message: arriving.message }; }
			state.commits.get(repository)?.add(sha);
			state.propagating.delete(key);
			return null;
		}
		return state.commits.get(repository)?.has(sha) ?? false ? null : { message: "Object does not exist" };
	};
	const route = (method: string, path: string, body: Record<string, unknown>,
		auth: { readonly kind: "app" } | { readonly kind: "installation"; readonly owner: string }, response: ServerResponse): void => {
		const url = new URL(path, "http://stub");
		const segments = segmentsOf(path);
		const repository = segments.length >= 3 ? `${segments[1]}/${segments[2]}` : "";
		if (auth.kind === "app" && method === "GET" && url.pathname === "/app/installations") {
			// GET /app/installations answers with a bare array.
			return json(response, 200, state.installations.map(item => ({ id: item.id, account: { login: item.account, type: "Organization" } })));
		}
		if (auth.kind === "app" && method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
			const id = Number(url.pathname.split("/")[3]);
			const token = `ghs_${randomBytes(20).toString("hex")}`;
			state.mints.push({ owner: state.installations.find(item => item.id === id)?.account ?? "", token });
			return json(response, 201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
		}
		if (method === "POST" && segments.length === 4 && segments[0] === "repos" && segments[3] === "forks") {
			// The org installation makes the fork. The source installation's token is refused administration=write.
			if (auth.kind !== "installation" || auth.owner !== ORG) {
				return json(response, 403, { message: "Resource not accessible by integration" },
					{ "x-accepted-github-permissions": "administration=write,contents=read" });
			}
			const requested = `${String(body.organization)}/${String(body.name)}`;
			// A taken name answers 403 "Name already exists on this account", the live API's answer for a fork.
			if (state.repos.has(requested)) return json(response, 403, { message: "Name already exists on this account" });
			const target = forkAs ?? requested;
			const created: StubRepo = { id: 1000 + state.repos.size, full_name: target, name: target.split("/")[1]!, owner: String(body.organization),
				default_branch: "main", fork: true, parent: { full_name: repository } };
			state.repos.set(target, created);
			state.commits.set(target, new Set(state.commits.get(repository) ?? []));
			state.refs.set(`${target}:main`, state.refs.get(`${repository}:main`) ?? "");
			state.forks.push(`${repository}->${target}`);
			return json(response, 202, created);
		}
		if (segments[0] === "repos" && segments.length === 3) {
			const found = state.repos.get(repository);
			if (method === "GET") return found ? json(response, 200, found) : json(response, 404, { message: "Not Found" });
			if (method === "DELETE" && found) {
				// GitHub answers 204 with no body for a repository it removed.
				state.repos.delete(repository);
				response.writeHead(204);
				response.end();
				return;
			}
			if (method === "PATCH" && found) {
				if (typeof body.name === "string") {
					state.repos.delete(repository);
					found.name = body.name;
					found.full_name = `${found.owner}/${body.name}`;
					state.repos.set(found.full_name, found);
				}
				if (typeof body.default_branch === "string") found.default_branch = body.default_branch;
				return json(response, 200, found);
			}
		}
		const refHead = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/);
		if (method === "GET" && refHead) {
			// A repository with no commits answers 409 "Git Repository is empty.", as the live API does.
			if ((state.commits.get(repository)?.size ?? 0) === 0) return json(response, 409, { message: "Git Repository is empty." });
			const sha = state.refs.get(`${repository}:${refHead[1]}`);
			return sha === undefined ? json(response, 404, { message: "Not Found" })
				: json(response, 200, { ref: `refs/heads/${refHead[1]}`, object: { sha, type: "commit" } });
		}
		if (method === "POST" && segments.length === 5 && segments[3] === "git" && segments[4] === "refs") {
			const branch = String(body.ref).replace(/^refs\/heads\//, "");
			const sha = String(body.sha);
			// The live API's answer for a sha the repository cannot reach, measured on a fresh fork push.
			const missing = commitMissing(repository, sha);
			if (missing) return json(response, 422, { message: missing.message });
			state.refs.set(`${repository}:${branch}`, sha);
			return json(response, 201, { ref: String(body.ref), object: { sha, type: "commit" } });
		}
		const refPatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/);
		if (method === "PATCH" && refPatch) {
			const sha = String(body.sha);
			// The live API refuses to point a ref at an object the repository does not have, as its create route does.
			const missing = commitMissing(repository, sha);
			if (missing) return json(response, 422, { message: missing.message });
			state.refs.set(`${repository}:${refPatch[1]}`, sha);
			return json(response, 200, { ref: `refs/heads/${refPatch[1]}`, object: { sha, type: "commit" } });
		}
		if (method === "GET" && url.pathname.endsWith("/pulls")) {
			const head = url.searchParams.get("head") ?? "";
			const wanted = url.searchParams.get("state") ?? "open";
			const items = state.pulls.filter(pull => pull.branch === repository && (head === "" || pull.head === head) && (wanted === "all" || pull.state === wanted))
				.map(pull => ({ number: pull.number, state: pull.state, title: pull.title, body: pull.body,
					head: { label: pull.head, ref: pull.head.split(":").at(-1), sha: state.refs.get(`${repository}:${pull.head.split(":").at(-1)}`) ?? "" },
					base: { ref: "main" } }));
			return json(response, 200, items);
		}
		if (method === "POST" && url.pathname.endsWith("/pulls")) {
			const head = String(body.head);
			const headOwner = head.includes(":") ? head.split(":")[0]! : repository.split("/")[0]!;
			// The rule the live probe measured: a cross-repository pull request is refused for the
			// installation that can reach the base repository but not the fork, and the head owner's
			// installation is refused by the base repository. Neither this App's token can create one.
			if (headOwner.toLowerCase() !== repository.split("/")[0]!.toLowerCase()) {
				if (auth.kind === "installation" && auth.owner.toLowerCase() === headOwner.toLowerCase()) {
					return json(response, 403, { message: "Resource not accessible by integration" });
				}
				return json(response, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] });
			}
			if (state.pulls.some(pull => pull.head === head && pull.state === "open")) return json(response, 422,
				{ message: "Validation Failed", errors: [{ message: `A pull request already exists for ${head}` }] });
			const branch = head.includes(":") ? head.split(":")[1]! : head;
			const number = 100 + state.pulls.length;
			state.pulls.push({ number, head, branch: repository, state: "open", title: String(body.title), body: String(body.body ?? ""),
				merged: false, merge_commit_sha: null });
			return json(response, 201, { number, state: "open", title: String(body.title), body: String(body.body ?? ""),
				head: { label: head, ref: branch, sha: state.refs.get(`${repository}:${branch}`) ?? "" }, base: { ref: String(body.base) } });
		}
		const pullNumber = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
		if (method === "GET" && pullNumber) {
			const pull = state.pulls.find(item => item.number === Number(pullNumber[1]) && item.branch === repository);
			if (!pull) return json(response, 404, { message: "Not Found" });
			return json(response, 200, { number: pull.number, state: pull.state, title: pull.title, merged: pull.merged,
				merge_commit_sha: pull.merge_commit_sha,
				head: { label: pull.head, ref: pull.head.split(":").at(-1), sha: state.refs.get(`${repository}:${pull.head.split(":").at(-1)}`) ?? "" },
				base: { ref: "main" } });
		}
		const mergePull = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/);
		if (method === "PUT" && mergePull) {
			const pull = state.pulls.find(item => item.number === Number(mergePull[1]) && item.branch === repository);
			if (!pull) return json(response, 404, { message: "Not Found" });
			// The live API answers 405 for a pull request it will not merge again.
			if (pull.merged) return json(response, 405, { message: "Pull Request is not mergeable" });
			if (pull.state !== "open") return json(response, 405, { message: "Pull Request is not mergeable" });
			// A merge that names another sha than the head is refused: the caller has to look again.
			const headSha = state.refs.get(`${repository}:${pull.head.split(":").at(-1)}`) ?? "";
			if (typeof body.sha === "string" && body.sha !== headSha) return json(response, 409,
				{ message: "Head branch was modified. Review and try the merge again." });
			pull.merged = true;
			pull.state = "closed";
			// The live API creates a merge commit: merge_commit_sha is the new commit on the base branch,
			// never the pull's head, which keeps pointing at the judged tree.
			pull.merge_commit_sha = MERGED;
			return json(response, 200, { sha: pull.merge_commit_sha, merged: true, message: "Pull Request successfully merged" });
		}
		if (method === "GET" && segments.length === 6 && segments[3] === "commits" && segments[5] === "check-runs") {
			const sha = segments[4];
			const name = url.searchParams.get("check_name") ?? "";
			const items = state.checks.filter(run => run.repo === repository && run.head_sha === sha && (name === "" || run.name === name));
			return json(response, 200, { total_count: items.length, check_runs: items });
		}
		if (method === "POST" && segments.length === 4 && segments[3] === "check-runs") {
			// GitHub keeps more than one run per name: the client's dedupe is the external id, not a 422.
			const run: StubCheck = { repo: repository, id: state.checks.length + 1, name: String(body.name), head_sha: String(body.head_sha),
				external_id: typeof body.external_id === "string" ? body.external_id : null,
				html_url: `https://github.com/${repository}/runs/${state.checks.length + 1}` };
			state.checks.push(run);
			return json(response, 201, run);
		}
		json(response, 500, { message: `The stub has no route for ${method} ${url.pathname}` });
	};
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
			const path = request.url ?? "";
			const authorization = request.headers.authorization ?? "";
			const posted = Buffer.concat(chunks).toString("utf8");
			// Every request body is kept, so a test can read back exactly what a mint asked GitHub for.
			state.requests.push({ method: request.method ?? "", path, authorization, body: posted === "" ? null : JSON.parse(posted) as unknown });
			if (hangs.some(prefix => path.startsWith(prefix))) return;
			const refused = refusals.find(item => item.method === request.method && path.startsWith(item.path));
			if (refused) {
				if (refused.once) refusals.splice(refusals.indexOf(refused), 1);
				return json(response, refused.status, { message: refused.message }, refused.headers);
			}
			const auth = authorize(authorization);
			if (auth === null) return json(response, 401, { message: "A JSON web token could not be decoded" });
			const body = posted === "" ? {} : JSON.parse(posted) as Record<string, unknown>;
			route(request.method ?? "", path, body, auth, response);
		})().catch(error => { json(response, 500, { message: String(error) }); });
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		state,
		seed(repository, commits, refs) {
			state.repos.set(repository, { id: 500 + state.repos.size, full_name: repository, name: repository.split("/")[1]!, owner: repository.split("/")[0]!,
				default_branch: "main", fork: false, parent: null });
			state.commits.set(repository, new Set(commits));
			for (const [branch, sha] of Object.entries(refs)) state.refs.set(`${repository}:${branch}`, sha);
		},
		refuse(item) { refusals.push({ method: item.method, path: item.path, status: item.status,
			message: item.message ?? "refused by the stub", headers: item.headers ?? {}, once: item.once ?? false }); },
		forkAs(name) { forkAs = name; },
		propagate(repository, sha, afterRefusals, message = "Object does not exist") { state.propagating.set(`${repository}:${sha}`, { remaining: afterRefusals, message }); },
		hang(prefix) { hangs.push(prefix); },
		close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
	};
}

async function withFake(): Promise<{ port: GitHubAppPort; close: () => Promise<void> }> {
	return { port: createFakeGitHubApp(), close: async () => {} };
}

async function withStub(): Promise<{ port: GitHubAppPort; stub: Stub; close: () => Promise<void> }> {
	const stub = await createGitHubStub({ appId: APP_ID, publicKey, installations: [{ id: 41, account: CLIENT_OWNER }, { id: 42, account: ORG }] });
	stub.seed(CLIENT, [FROZEN, HEAD], { main: HEAD });
	return { port: createGitHubApp({ ...CONFIG, apiBase: stub.url }), stub, close: () => stub.close() };
}

const HARNESSES: readonly { readonly name: string; make: () => Promise<{ port: GitHubAppPort; close: () => Promise<void> }> }[] =
	[{ name: "fake", make: withFake }, { name: "stub", make: withStub }];

for (const harness of HARNESSES) {
	test(`the work repo is one repository per job and a second call adopts it (${harness.name})`, async t => {
		const app = await harness.make();
		t.after(app.close);
		const created = await app.port.createWorkRepo(workRepoRequest, "req-1");
		assert.deepEqual(created, { repository: WORK_REPO, remote: `https://github.com/${WORK_REPO}.git`, branch: "main", commit: FROZEN });
		assert.deepEqual(await app.port.createWorkRepo(workRepoRequest, "req-2"), created);
		const other = await app.port.createWorkRepo({ ...workRepoRequest, jobId: OTHER_JOB }, "req-3");
		assert.equal(other.repository, `${ORG}/invoice-app-8Z3P`);
		assert.notEqual(other.repository, created.repository);
	});

	test(`a visitor's repository is one fork per visitor name, and a second call adopts it (${harness.name})`, async t => {
		const app = await harness.make();
		t.after(app.close);
		const request = { repository: CLIENT, name: "demo-abc123" };
		const created = await app.port.createClientRepo(request);
		assert.deepEqual(created, { repository: `${ORG}/demo-abc123`, remote: `https://github.com/${ORG}/demo-abc123.git` });
		assert.deepEqual(await app.port.createClientRepo(request), created);
		const other = await app.port.createClientRepo({ repository: CLIENT, name: "demo-def456" });
		assert.equal(other.repository, `${ORG}/demo-def456`);
		assert.notEqual(other.repository, created.repository);
		// The expiry sweep removes the visitor's own fork, and a second removal finds it absent.
		assert.equal(await app.port.deleteClientRepo({ repository: created.repository, source: CLIENT }), "DELETED");
		assert.equal(await app.port.deleteClientRepo({ repository: created.repository, source: CLIENT }), "ABSENT");
		assert.equal(await app.port.deleteClientRepo({ repository: other.repository, source: CLIENT }), "DELETED");
	});

	test(`the verified commit is one pull request and a second call adopts it (${harness.name})`, async t => {
		const app = await harness.make();
		t.after(app.close);
		const published = await app.port.publishVerified(publishRequest, "req-1");
		assert.equal(published.repository, CLIENT);
		assert.equal(published.mergeCommit, FROZEN);
		assert.ok(published.pullRequest > 0);
		assert.notEqual(published.checkRunUrl, null);
		assert.deepEqual(await app.port.publishVerified(publishRequest, "req-2"), published);
	});

	test(`the judged tree merges once and a retry adopts the merge (${harness.name})`, async t => {
		const app = await harness.make();
		t.after(app.close);
		const published = await app.port.publishVerified(publishRequest, "req-1");
		const request = { jobId: JOB, repository: CLIENT, pullRequest: published.pullRequest, mergeCommit: published.mergeCommit };
		// The fake fast-forwards the base to the published commit. GitHub creates a merge commit of its own,
		// so both harnesses answer the commit the merge actually landed on.
		const landed = harness.name === "fake" ? published.mergeCommit : MERGED as CommitSha;
		assert.deepEqual(await app.port.merge(request, "req-2"), { outcome: "MERGED", sha: landed });
		// GitHub refuses a second merge of the same pull request. The client reads the pull and reports the
		// merge that already landed instead of failing, which is what makes the outbox retry safe.
		assert.deepEqual(await app.port.merge(request, "req-3"), { outcome: "MERGED", sha: landed });
		// A pull request that names another tree is not this job's artifact: a person has to look.
		assert.deepEqual(await app.port.merge({ ...request, mergeCommit: HEAD as CommitSha }, "req-4"), { outcome: "CONFLICT" });
	});

	test(`two jobs on one client repo get their own work repo and pull request (${harness.name})`, async t => {
		const app = await harness.make();
		t.after(app.close);
		const first = await app.port.publishVerified(publishRequest, "req-1");
		const second = await app.port.publishVerified({ ...publishRequest, jobId: OTHER_JOB }, "req-2");
		assert.notEqual(second.pullRequest, first.pullRequest);
		assert.equal(second.repository, CLIENT);
	});
}

test("a landed merge is adopted by the pull's head, not by merge_commit_sha", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const published = await port.publishVerified(publishRequest, "req-1");
	const request = { jobId: JOB, repository: CLIENT, pullRequest: published.pullRequest, mergeCommit: published.mergeCommit };
	assert.deepEqual(await port.merge(request, "req-2"), { outcome: "MERGED", sha: MERGED as CommitSha });
	// merge_method "merge" created a new commit: merge_commit_sha names it, and the head still names the
	// judged tree. Comparing merge_commit_sha with the judged tree would read this landed merge as a conflict.
	assert.equal(stub.state.pulls[0]?.merge_commit_sha, MERGED);
	assert.notEqual(stub.state.pulls[0]?.merge_commit_sha, published.mergeCommit);
	// Adopting the merge that landed answers that same commit GitHub made, never the tree still standing.
	assert.deepEqual(await port.merge(request, "req-3"), { outcome: "MERGED", sha: MERGED as CommitSha });
});

test("a landed merge GitHub names no commit for is a response this client refuses", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const published = await port.publishVerified(publishRequest, "req-1");
	// A pull the stub reports as merged while merge_commit_sha names nothing. No commit landed that this
	// client could show, so it refuses the answer by name instead of reporting a merge nobody can read back.
	const pull = stub.state.pulls.find(item => item.number === published.pullRequest);
	assert.ok(pull);
	pull.merged = true;
	pull.state = "closed";
	pull.merge_commit_sha = null;
	assert.deepEqual(await refusal(port.merge({ jobId: JOB, repository: CLIENT, pullRequest: published.pullRequest,
		mergeCommit: published.mergeCommit }, "req-2")), { code: "GITHUB_RESPONSE_INVALID", status: null, permission: null,
		detail: "GitHub answered a landed merge without naming the commit it made." });
});

test("the App JWT is RS256, signed by the App, and inside GitHub's ten-minute cap", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	const appCall = stub.state.requests.find(request => request.path.startsWith("/app/installations"));
	assert.ok(appCall);
	const [header, payload, signature] = appCall.authorization.replace("Bearer ", "").split(".");
	const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { iss: string; iat: number; exp: number };
	assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });
	assert.equal(claims.iss, APP_ID);
	assert.ok(claims.exp - claims.iat <= 600);
	assert.ok(claims.iat <= Math.floor(Date.now() / 1000));
	assert.equal(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url")), true);
});

test("the installation token is a bearer header on every call and never a URL", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	await port.publishVerified(publishRequest, "req-2");
	assert.ok(stub.state.requests.length > 6);
	assert.equal(stub.state.mints.length > 0, true);
	for (const request of stub.state.requests) {
		assert.match(request.authorization, /^Bearer \S+$/);
		for (const mint of stub.state.mints) assert.equal(request.path.includes(mint.token), false, request.path);
	}
	const installationCalls = stub.state.requests.filter(request => request.path.startsWith("/repos/"));
	assert.ok(installationCalls.every(request => stub.state.mints.some(mint => mint.token === request.authorization.slice("Bearer ".length))));
});

test("one installation token per owner is minted and reused for later calls", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	await port.publishVerified(publishRequest, "req-2");
	assert.equal(stub.state.mints.length, 2);
	assert.equal(stub.state.requests.filter(request => request.method === "GET" && request.path.startsWith("/app/installations")).length, 1);
});

test("the port mints an installation token for a caller outside its own operations", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const token = await port.installationToken(CLIENT_OWNER);
	assert.equal(stub.state.mints.some(mint => mint.token === token && mint.owner === CLIENT_OWNER), true);
	assert.equal(await port.installationToken(CLIENT_OWNER), token);
	assert.equal(stub.state.mints.length, 1);
});

test("a scoped mint names exactly the repository and the least privilege the run needs", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const token = await port.installationToken(ORG, [workRepoName(CLIENT, JOB)]);
	assert.equal(workRepoName(CLIENT, JOB), "invoice-app-7Q2K");
	// The answer came from the one mint the stub made, and the body is what scopes it.
	assert.equal(stub.state.mints.some(mint => mint.token === token && mint.owner === ORG), true);
	const mint = stub.state.requests.find(request => request.method === "POST" && request.path === "/app/installations/42/access_tokens");
	assert.ok(mint);
	assert.deepEqual(mint.body, { repositories: ["invoice-app-7Q2K"], permissions: { contents: "write", metadata: "read" } });
});

test("the scope is part of the token cache, so a token is never served for another scope", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const scoped = await port.installationToken(ORG, [workRepoName(CLIENT, JOB)]);
	assert.equal(await port.installationToken(ORG, [workRepoName(CLIENT, JOB)]), scoped);
	assert.equal(stub.state.mints.length, 1);
	// Neither the owner's own token nor another repository's scope may reuse the cached one.
	const otherRepo = await port.installationToken(ORG, [workRepoName(CLIENT, OTHER_JOB)]);
	const owner = await port.installationToken(ORG);
	assert.notEqual(otherRepo, scoped);
	assert.notEqual(owner, scoped);
	assert.equal(stub.state.mints.length, 3);
	// The owner-wide mint keeps the behavior it had before: no body at all.
	const bodies = stub.state.requests.filter(request => request.method === "POST" && request.path === "/app/installations/42/access_tokens")
		.map(request => request.body);
	assert.deepEqual(bodies, [
		{ repositories: ["invoice-app-7Q2K"], permissions: { contents: "write", metadata: "read" } },
		{ repositories: ["invoice-app-8Z3P"], permissions: { contents: "write", metadata: "read" } },
		null,
	]);
});

test("a rate-limited mint is named and its copied text carries no token shape", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.refuse({ method: "POST", path: "/app/installations/41/access_tokens", status: 403,
		message: "You have exceeded a secondary rate limit. Token ghs_SYNTHETIC_INSTALLATION_TOKEN was included.",
		headers: { "x-ratelimit-remaining": "0" } });
	const failure = await refusal(port.installationToken(CLIENT_OWNER));
	assert.equal(failure.code, "GITHUB_RATE_LIMITED");
	assert.equal(failure.detail.includes("ghs_SYNTHETIC_INSTALLATION_TOKEN"), false);
	assert.match(failure.detail, /\[redacted\]/);
});

test("the fake port mints a token for the unit path", async () => {
	const port = createFakeGitHubApp();
	assert.equal(await port.installationToken(CLIENT_OWNER), await port.installationToken(CLIENT_OWNER));
	const scoped = await port.installationToken(CLIENT_OWNER, ["invoice-app-7Q2K"]);
	assert.notEqual(scoped, await port.installationToken(CLIENT_OWNER));
	assert.equal(await port.installationToken(CLIENT_OWNER, ["invoice-app-7Q2K"]), scoped);
});

test("the work repo is the client repo's fork with main at the frozen commit", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	assert.deepEqual(stub.state.forks, [`${CLIENT}->${WORK_REPO}`]);
	assert.equal(stub.state.refs.get(`${WORK_REPO}:main`), FROZEN);
	assert.equal(stub.state.repos.get(WORK_REPO)?.fork, true);
});

test("a commit pushed to the client repo becomes a same-repo pull request with a check run", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const published = await port.publishVerified(publishRequest, "req-1");
	assert.equal(stub.state.refs.get(`${CLIENT}:acquit/${JOB}`), FROZEN);
	assert.equal(stub.state.pulls.at(0)?.head, `${CLIENT_OWNER}:acquit/${JOB}`);
	assert.equal(stub.state.checks.at(0)?.repo, CLIENT);
	assert.equal(stub.state.checks.at(0)?.name, CHECK_NAME);
	assert.equal(stub.state.checks.at(0)?.head_sha, FROZEN);
	assert.equal(published.pullRequest, stub.state.pulls.at(0)?.number);
	assert.equal(published.checkRunUrl, stub.state.checks.at(0)?.html_url);
});

test("a fresh fork commit the client repository takes late converges on the client branch for both of the create's refusals", async t => {
	// The submitter pushed the commit to the job's fork. GitHub exposes a fresh fork commit to the
	// client repository — the fork network's parent — only after it has indexed the push. The live
	// first publish answered "Object does not exist", and on the next run the identical POST answered
	// "Reference update failed" for about two minutes before it answered 201. Both mean the object is
	// not visible there yet, so both wait out the same convergence budget.
	for (const message of ["Object does not exist", "Reference update failed"]) {
		const { port, stub, close } = await withStub();
		try {
			await port.createWorkRepo(workRepoRequest, "req-1");
			stub.state.commits.get(WORK_REPO)?.add(SUBMITTED);
			stub.propagate(CLIENT, SUBMITTED, 2, message);
			const published = await port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-2");
			assert.equal(stub.state.refs.get(`${CLIENT}:acquit/${JOB}`), SUBMITTED, message);
			assert.equal(stub.state.pulls.at(0)?.head, `${CLIENT_OWNER}:acquit/${JOB}`, message);
			assert.equal(stub.state.checks.at(0)?.repo, CLIENT, message);
			assert.equal(stub.state.checks.at(0)?.head_sha, SUBMITTED, message);
			assert.equal(published.mergeCommit, SUBMITTED, message);
			// The client repository took the commit, so the fork never carries the publisher's branch.
			assert.equal(stub.state.refs.has(`${WORK_REPO}:acquit/${JOB}`), false, message);
			// The create waited: two refusals, then the write that landed.
			assert.equal(stub.state.requests.filter(request => request.method === "POST" && request.path === `/repos/${CLIENT}/git/refs`).length, 3, message);
		} finally { await close(); }
	}
});

test("the create's other wording is not accepted on the branch move", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	// "Reference update failed" is the create's own wording for a not-yet-visible object. A branch move
	// is not the create: reading this text as an absent object there would burn the budget and branch
	// the fork for a reason GitHub never named.
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, HEAD);
	stub.refuse({ method: "PATCH", path: `/repos/${CLIENT}/git/refs/heads/acquit/${JOB}`, status: 422, message: "Reference update failed" });
	const failure = await refusal(port.publishVerified(publishRequest, "req-2"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 422);
	assert.match(failure.detail, /Reference update failed/);
	assert.equal(stub.state.refs.has(`${WORK_REPO}:acquit/${JOB}`), false);
	assert.deepEqual(stub.state.pulls, []);
});

test("a commit the client repository never takes is branched on the fork, and GitHub refuses the cross-repo pull request", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	stub.state.commits.get(WORK_REPO)?.add(SUBMITTED);
	const failure = await refusal(port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-2"));
	// The wait is bounded. After it the fork carries the branch, and GitHub's own text names the rule
	// that stops the cross-repository pull request. The client repository is left untouched.
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 422);
	assert.match(failure.detail, /Validation Failed/);
	assert.equal(stub.state.refs.get(`${WORK_REPO}:acquit/${JOB}`), SUBMITTED);
	assert.equal(stub.state.refs.has(`${CLIENT}:acquit/${JOB}`), false);
	assert.deepEqual(stub.state.pulls, []);
});

test("a 422 from the pull request POST carries GitHub's own message into the refusal", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	// GitHub explains a refused pull request in the body. The refusal has to carry that text: the
	// operator acts on what the server said, not on this client's reading of the status alone.
	stub.refuse({ method: "POST", path: `/repos/${CLIENT}/pulls`, status: 422,
		message: "Validation Failed", headers: {} });
	const failure = await refusal(port.publishVerified(publishRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 422);
	assert.match(failure.detail, /Validation Failed/);
});

test("a pull request whose head moved is never merged, and the refusal is a conflict", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const published = await port.publishVerified(publishRequest, "req-1");
	// The head moves after the verdict. GitHub refuses a merge that names another sha, and the client
	// reads the pull once more rather than merging whatever is there now.
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, SUBMITTED);
	const request = { jobId: JOB, repository: CLIENT, pullRequest: published.pullRequest, mergeCommit: published.mergeCommit };
	assert.deepEqual(await port.merge(request, "req-2"), { outcome: "CONFLICT" });
	assert.equal(stub.state.pulls.at(0)?.merged, false);
	// The moved head is still not merged, and the client says the same thing when asked again.
	assert.deepEqual(await port.merge(request, "req-3"), { outcome: "CONFLICT" });
});

test("an existing verified branch at another commit is moved to the judged commit", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	// A publish that did not finish left the client repository's acquit/<job> branch at an earlier commit.
	stub.state.commits.get(CLIENT)?.add(SUBMITTED);
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, HEAD);
	const published = await port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-1");
	assert.equal(stub.state.refs.get(`${CLIENT}:acquit/${JOB}`), SUBMITTED);
	assert.equal(stub.state.pulls.at(0)?.head, `${CLIENT_OWNER}:acquit/${JOB}`);
	assert.equal(published.pullRequest, stub.state.pulls.at(0)?.number);
	assert.equal(published.mergeCommit, SUBMITTED);
	assert.equal(stub.state.checks.at(0)?.head_sha, SUBMITTED);
});

test("a branch move refused for any other reason is a refusal, never a fork fallback", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	// The branch exists at another commit, so the publisher moves it. GitHub refuses the move for a
	// reason of its own; only the object missing means the fork can carry the commit instead.
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, HEAD);
	stub.refuse({ method: "PATCH", path: `/repos/${CLIENT}/git/refs/heads/acquit/${JOB}`, status: 422,
		message: "Update is not a fast forward" });
	const failure = await refusal(port.publishVerified(publishRequest, "req-2"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 422);
	assert.match(failure.detail, /not a fast forward/);
	assert.equal(stub.state.refs.has(`${WORK_REPO}:acquit/${JOB}`), false);
	assert.deepEqual(stub.state.pulls, []);
});

test("a 409 on the branch move is a refusal with GitHub's message, never a fork fallback", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, HEAD);
	stub.refuse({ method: "PATCH", path: `/repos/${CLIENT}/git/refs/heads/acquit/${JOB}`, status: 409,
		message: "Git Repository is empty." });
	const failure = await refusal(port.publishVerified(publishRequest, "req-2"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 409);
	assert.match(failure.detail, /Git Repository is empty/);
	assert.equal(stub.state.refs.has(`${WORK_REPO}:acquit/${JOB}`), false);
	assert.deepEqual(stub.state.pulls, []);
});

test("a ref create refused for another reason refuses at once, never a fork fallback", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	// The verified branch does not exist yet, so the publisher creates it. GitHub refuses the create on
	// a rule of its own — not the object-missing answer that means the fork can carry the commit. The
	// refusal must reach the caller at once: waiting out the convergence budget and branching the fork
	// would ask for a pull request GitHub refuses for that other reason.
	stub.refuse({ method: "POST", path: `/repos/${CLIENT}/git/refs`, status: 422, message: "Validation Failed" });
	const failure = await refusal(port.publishVerified(publishRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 422);
	assert.match(failure.detail, /Validation Failed/);
	// One create: the convergence loop must not retry an answer that is not the object missing.
	assert.equal(stub.state.requests.filter(request => request.method === "POST" && request.path === `/repos/${CLIENT}/git/refs`).length, 1);
	// No fork: only the absent-object answer branches.
	assert.equal(stub.state.requests.some(request => request.path.startsWith(`/repos/${WORK_REPO}`)), false);
});

test("a later clean commit moves the branch the previous publish made and adopts its pull request", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	// A previous publish left the branch, the pull request, and the check run at the first commit; the job
	// is back at READY, and the operator's next clean commit is judged later.
	const first = await port.publishVerified(publishRequest, "req-1");
	stub.state.commits.get(CLIENT)?.add(SUBMITTED);
	const second = await port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-2");
	assert.equal(stub.state.refs.get(`${CLIENT}:acquit/${JOB}`), SUBMITTED);
	assert.deepEqual(stub.state.pulls.map(pull => pull.number), [first.pullRequest]);
	assert.equal(second.pullRequest, first.pullRequest);
	assert.equal(second.mergeCommit, SUBMITTED);
	// The check run is per commit: the judged commit gets its own, keyed by the job's external id.
	assert.equal(stub.state.checks.length, 2);
	assert.equal(stub.state.checks.at(1)?.head_sha, SUBMITTED);
	assert.equal(stub.state.checks.at(1)?.external_id, JOB);
});

test("a branch the client repository cannot move leaves the fork branch at the judged commit", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	// The previous publish left the branch on both repositories; the next clean commit is only on the
	// work fork, so the client repository's ref update is refused and the fork carries the branch. The
	// cross-repository pull request that follows is the one GitHub refuses.
	stub.state.commits.get(WORK_REPO)?.add(SUBMITTED);
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, FROZEN);
	stub.state.refs.set(`${WORK_REPO}:acquit/${JOB}`, FROZEN);
	const failure = await refusal(port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-2"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 422);
	assert.match(failure.detail, /Validation Failed/);
	assert.equal(stub.state.requests.some(request => request.method === "PATCH" && request.path === `/repos/${CLIENT}/git/refs/heads/acquit/${JOB}`), true);
	assert.equal(stub.state.requests.some(request => request.method === "PATCH" && request.path === `/repos/${WORK_REPO}/git/refs/heads/acquit/${JOB}`), true);
	assert.equal(stub.state.refs.get(`${CLIENT}:acquit/${JOB}`), FROZEN);
	assert.equal(stub.state.refs.get(`${WORK_REPO}:acquit/${JOB}`), SUBMITTED);
	assert.deepEqual(stub.state.pulls, []);
});

test("an org without the App refuses by name before any write", async t => {
	const stub = await createGitHubStub({ appId: APP_ID, publicKey, installations: [{ id: 41, account: CLIENT_OWNER }] });
	t.after(() => stub.close());
	const port = createGitHubApp({ ...CONFIG, apiBase: stub.url });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_INSTALLATION_MISSING");
	assert.match(failure.detail, new RegExp(ORG));
	assert.equal(stub.state.requests.every(request => request.method === "GET" || request.path.startsWith("/app/installations")), true);
});

test("a 403 names the permission GitHub reports as missing", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.refuse({ method: "POST", path: `/repos/${CLIENT}/pulls`, status: 403, message: "Resource not accessible by integration",
		headers: { "x-accepted-github-permissions": "pull_requests=write" } });
	const failure = await refusal(port.publishVerified(publishRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_PERMISSION_MISSING");
	assert.equal(failure.status, 403);
	assert.equal(failure.permission, "pull_requests=write");
	assert.match(failure.detail, /pull_requests=write/);
});

test("a rate limit refusal names the reset", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.refuse({ method: "GET", path: "/app/installations", status: 403, message: "API rate limit exceeded",
		headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_RATE_LIMITED");
	assert.match(failure.detail, /resets at 20\d\d-/);
});

test("a request that never answers stops at the timeout", async t => {
	const stub = await createGitHubStub({ appId: APP_ID, publicKey, installations: [{ id: 41, account: CLIENT_OWNER }] });
	t.after(() => stub.close());
	stub.hang("/app/installations");
	const port = createGitHubApp({ ...CONFIG, apiBase: stub.url, timeoutMs: 100 });
	const started = Date.now();
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_TIMEOUT");
	assert.match(failure.detail, /timed out after 100 ms/);
	assert.ok(Date.now() - started < 5_000);
});

test("an endpoint that is gone refuses as a network failure", async t => {
	const stub = await createGitHubStub({ appId: APP_ID, publicKey, installations: [{ id: 41, account: CLIENT_OWNER }] });
	const port = createGitHubApp({ ...CONFIG, apiBase: stub.url, timeoutMs: 500 });
	await stub.close();
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_NETWORK");
});

test("a private key that is not a PEM refuses by name before any dial", async t => {
	const port = createGitHubApp({ appId: APP_ID, privateKey: "not-a-pem", organization: ORG, apiBase: "http://127.0.0.1:1", timeoutMs: 100 });
	const started = Date.now();
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_APP_KEY_INVALID");
	assert.match(failure.detail, /ACQUIT_GITHUB_APP_PRIVATE_KEY/);
	assert.ok(Date.now() - started < 1_000);
});

// The wire this client owes: what it refuses, what it adopts, and what it must never move.

/** A second listener that records whether a redirected request arrives. */
async function withThief(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
	const seen: string[] = [];
	const server = createServer((request, response) => {
		seen.push(request.url ?? "");
		response.writeHead(200, { "content-type": "application/json" });
		response.end("[]");
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/stolen`, seen,
		close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** Puts a repository at the computed work name that this client did not create, or a fork of some source. */
function plant(stub: Stub, repository: string, options: { readonly forkOf: string | null;
	readonly commits: readonly string[]; readonly main: string | null }): void {
	const [owner, name] = repository.split("/") as [string, string];
	stub.state.repos.set(repository, { id: 700 + stub.state.repos.size, full_name: repository, name, owner, default_branch: "main",
		fork: options.forkOf !== null, parent: options.forkOf === null ? null : { full_name: options.forkOf } });
	stub.state.commits.set(repository, new Set(options.commits));
	if (options.main !== null) stub.state.refs.set(`${repository}:main`, options.main);
}

/** Every mutation a refusal must never make: a rename, a delete, or a ref write. */
const repoMutations = (stub: Stub): string[] => stub.state.requests
	.filter(request => request.method === "PATCH" || request.method === "DELETE" ||
		(request.method === "POST" && /\/git\/refs$/.test(request.path)))
	.map(request => `${request.method} ${request.path}`);

test("a fork GitHub names differently is refused by name and never renamed", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const other = `${ORG}/invoice-app-7Q2K-1`;
	stub.forkAs(other);
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.match(failure.detail, new RegExp(other));
	assert.equal(stub.state.repos.has(WORK_REPO), false);
	assert.equal(stub.state.repos.has(other), true);
	assert.deepEqual(repoMutations(stub), []);
});

test("a visitor's name already taken by a repository this client did not create is refused", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	plant(stub, `${ORG}/demo-abc123`, { forkOf: null, commits: [], main: null });
	const failure = await refusal(port.createClientRepo({ repository: CLIENT, name: "demo-abc123" }));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.match(failure.detail, /demo-abc123/);
	// The refused name is never forked over and nothing is renamed, deleted, or written.
	assert.deepEqual(stub.state.forks, []);
	assert.deepEqual(repoMutations(stub), []);
});

test("a visitor's name taken between the read and the fork is adopted only with the ownership marker", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const name = "demo-abc123";
	// The read misses the fork another request created in the same instant, and the fork answers "already
	// exists". The name now holds a repository this client did not create: it is refused, never adopted.
	stub.refuse({ method: "GET", path: `/repos/${ORG}/${name}`, status: 404, message: "Not Found", once: true });
	plant(stub, `${ORG}/${name}`, { forkOf: null, commits: [], main: null });
	const failure = await refusal(port.createClientRepo({ repository: CLIENT, name }));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.match(failure.detail, /demo-abc123/);
	assert.deepEqual(stub.state.forks, [], "no second fork is made for a name already taken");
	// The same race with this visitor's own fork at the name: the retry re-reads and adopts it.
	plant(stub, `${ORG}/${name}`, { forkOf: CLIENT, commits: [], main: null });
	stub.refuse({ method: "GET", path: `/repos/${ORG}/${name}`, status: 404, message: "Not Found", once: true });
	const adopted = await port.createClientRepo({ repository: CLIENT, name });
	assert.equal(adopted.repository, `${ORG}/${name}`);
	assert.deepEqual(stub.state.forks, []);
});

test("a fork is deleted only while the repository id is the one the visitor forked", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const created = await port.createClientRepo({ repository: CLIENT, name: "demo-abc123" });
	assert.equal(typeof created.id, "number", "the fork's answer carries the repository id");
	// The visitor's fork is gone and another repository of the same source holds the name: the ownership
	// marker cannot tell those two apart, the id can.
	plant(stub, created.repository, { forkOf: CLIENT, commits: [], main: null });
	const failure = await refusal(port.deleteClientRepo({ repository: created.repository, source: CLIENT, id: created.id }));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.match(failure.detail, /demo-abc123/);
	assert.equal(stub.state.repos.has(created.repository), true, "nothing is deleted");
	// A visitor row from before the id was recorded still deletes by the marker alone.
	assert.equal(await port.deleteClientRepo({ repository: created.repository, source: CLIENT, id: null }), "DELETED");
	// And the fork this client did make, with the id it recorded, is deleted.
	const again = await port.createClientRepo({ repository: CLIENT, name: "demo-def456" });
	assert.equal(await port.deleteClientRepo({ repository: again.repository, source: CLIENT, id: again.id }), "DELETED");
	assert.equal(stub.state.repos.has(again.repository), false);
});

test("the sweep never deletes a repository this client did not create", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	plant(stub, `${ORG}/demo-abc123`, { forkOf: null, commits: [], main: null });
	const failure = await refusal(port.deleteClientRepo({ repository: `${ORG}/demo-abc123`, source: CLIENT }));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.equal(stub.state.repos.has(`${ORG}/demo-abc123`), true);
	// A repository this client did create is removed, and a name that is not there is already gone.
	await port.createClientRepo({ repository: CLIENT, name: "demo-def456" });
	assert.equal(await port.deleteClientRepo({ repository: `${ORG}/demo-def456`, source: CLIENT }), "DELETED");
	assert.equal(await port.deleteClientRepo({ repository: `${ORG}/demo-def456`, source: CLIENT }), "ABSENT");
	assert.equal(stub.state.repos.has(`${ORG}/demo-def456`), false);
});

test("a fork this client created converges after its ref move failed", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.refuse({ method: "PATCH", path: `/repos/${WORK_REPO}/git/refs/heads/main`, status: 500, message: "one transient failure", once: true });
	const first = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(first.code, "GITHUB_HTTP_ERROR");
	assert.equal(stub.state.refs.get(`${WORK_REPO}:main`), HEAD);
	// The retry finds the fork this client made: main is moved to the frozen commit instead of refused.
	const adopted = await port.createWorkRepo(workRepoRequest, "req-2");
	assert.deepEqual(adopted, { repository: WORK_REPO, remote: `https://github.com/${WORK_REPO}.git`, branch: "main", commit: FROZEN });
	assert.equal(stub.state.refs.get(`${WORK_REPO}:main`), FROZEN);
});

test("a repository this client did not create is refused by name and never moved", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	plant(stub, WORK_REPO, { forkOf: null, commits: [], main: null });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.equal(stub.state.refs.has(`${WORK_REPO}:main`), false);
	assert.deepEqual(repoMutations(stub), []);
});

test("a fork of another repository at the job's name is refused by name and never moved", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	plant(stub, WORK_REPO, { forkOf: "someone/else", commits: [FROZEN, HEAD], main: HEAD });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.equal(stub.state.refs.get(`${WORK_REPO}:main`), HEAD);
	assert.deepEqual(repoMutations(stub), []);
});

test("a fork refused with 403 name-exists goes through the same ownership and ref checks", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	// The concurrent attempt of this job won the name between this call's check and its fork.
	plant(stub, WORK_REPO, { forkOf: CLIENT, commits: [FROZEN, HEAD], main: HEAD });
	stub.refuse({ method: "GET", path: `/repos/${WORK_REPO}`, status: 404, message: "Not Found", once: true });
	const adopted = await port.createWorkRepo(workRepoRequest, "req-1");
	assert.equal(adopted.repository, WORK_REPO);
	assert.equal(stub.state.refs.get(`${WORK_REPO}:main`), FROZEN);
});

test("a 403 name-exists on a repository this client did not create is not a permission refusal", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	plant(stub, WORK_REPO, { forkOf: null, commits: [], main: null });
	stub.refuse({ method: "GET", path: `/repos/${WORK_REPO}`, status: 404, message: "Not Found", once: true });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_FORK_MISMATCH");
	assert.deepEqual(repoMutations(stub), []);
});

test("a duplicate-ref 422 adopts the ref and never opens a second pull request", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	// The submitter pushed the verified commit to the work fork; the client repo has it too.
	stub.state.commits.get(CLIENT)?.add(SUBMITTED);
	stub.state.commits.get(WORK_REPO)?.add(SUBMITTED);
	// The winner of the race already created the branch on the client repo and opened its pull request.
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, SUBMITTED);
	stub.state.pulls.push({ number: 500, head: `${CLIENT_OWNER}:acquit/${JOB}`, branch: CLIENT, state: "open",
		title: `Acquit verifier: ${JOB}`, body: "", merged: false, merge_commit_sha: null });
	// The loser read the ref before the winner created it, so its create answers the duplicate-ref 422.
	stub.refuse({ method: "GET", path: `/repos/${CLIENT}/git/ref/heads/acquit/${JOB}`, status: 404, message: "Not Found", once: true });
	stub.refuse({ method: "POST", path: `/repos/${CLIENT}/git/refs`, status: 422, message: "Reference already exists", once: true });
	const published = await port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-2");
	assert.equal(published.pullRequest, 500);
	assert.deepEqual(stub.state.pulls.map(pull => pull.number), [500]);
	assert.equal(stub.state.checks.length, 1);
	assert.equal(stub.state.checks.at(0)?.repo, CLIENT);
});

test("a duplicate-ref 409 adopts the ref the same way", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	stub.state.commits.get(CLIENT)?.add(SUBMITTED);
	stub.state.refs.set(`${CLIENT}:acquit/${JOB}`, SUBMITTED);
	stub.state.pulls.push({ number: 500, head: `${CLIENT_OWNER}:acquit/${JOB}`, branch: CLIENT, state: "open",
		title: `Acquit verifier: ${JOB}`, body: "", merged: false, merge_commit_sha: null });
	stub.refuse({ method: "GET", path: `/repos/${CLIENT}/git/ref/heads/acquit/${JOB}`, status: 404, message: "Not Found", once: true });
	stub.refuse({ method: "POST", path: `/repos/${CLIENT}/git/refs`, status: 409, message: "Reference already exists", once: true });
	const published = await port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-2");
	assert.equal(published.pullRequest, 500);
	assert.deepEqual(stub.state.pulls.map(pull => pull.number), [500]);
});

test("check runs are deduped by the job's external id, so another job's run is not adopted", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.state.checks.push({ repo: CLIENT, id: 1, name: CHECK_NAME, head_sha: FROZEN, external_id: OTHER_JOB,
		html_url: `https://github.com/${CLIENT}/runs/1` });
	const published = await port.publishVerified(publishRequest, "req-1");
	assert.equal(stub.state.checks.length, 2);
	assert.equal(stub.state.checks.at(1)?.external_id, JOB);
	assert.equal(published.checkRunUrl, stub.state.checks.at(1)?.html_url);
	assert.deepEqual(await port.publishVerified(publishRequest, "req-2"), published);
	assert.equal(stub.state.checks.length, 2);
});

test("an installation added after INSTALLATION_MISSING is seen without a restart", async t => {
	const stub = await createGitHubStub({ appId: APP_ID, publicKey, installations: [{ id: 41, account: CLIENT_OWNER }] });
	t.after(() => stub.close());
	stub.seed(CLIENT, [FROZEN, HEAD], { main: HEAD });
	const port = createGitHubApp({ ...CONFIG, apiBase: stub.url });
	const first = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(first.code, "GITHUB_INSTALLATION_MISSING");
	stub.state.installations.push({ id: 42, account: ORG });
	const adopted = await port.createWorkRepo(workRepoRequest, "req-2");
	assert.equal(adopted.repository, WORK_REPO);
});

test("a response body over the cap is refused by name", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.refuse({ method: "GET", path: "/app/installations", status: 200, message: "x".repeat(2 * 1024 * 1024) });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_RESPONSE_INVALID");
	assert.match(failure.detail, /more than 1048576 bytes/);
});

test("a legacy token in a refusal body is redacted before the error copies it", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const legacy = `v1.${"d3adb33f5ec0ffee".repeat(3).slice(0, 40)}`;
	stub.refuse({ method: "GET", path: `/repos/${WORK_REPO}`, status: 403, message: `${"x".repeat(256)}${legacy} refused` });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_PERMISSION_MISSING");
	assert.equal(failure.detail.startsWith(`GET /repos/${WORK_REPO} answered 403: ${"x".repeat(256)}[redacted] refused`), true, failure.detail);
});

test("server text copied into an error is bounded and stripped of token shapes", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const token = `ghs_${"a".repeat(36)}`;
	stub.refuse({ method: "GET", path: "/app/installations", status: 500,
		message: `${token} temp_clone_token=${token} Bearer ${token} ${"z".repeat(4_000)}` });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.ok(failure.detail.length < 400, `detail is ${failure.detail.length} characters`);
	assert.equal(failure.detail.includes(token), false);
	assert.match(failure.detail, /\[redacted\]/);
});

test("a redirect is refused instead of following the bearer header to another host", async t => {
	const thief = await withThief();
	t.after(thief.close);
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.refuse({ method: "GET", path: "/app/installations", status: 302, message: "Found", headers: { location: thief.url } });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_NETWORK");
	assert.deepEqual(thief.seen, []);
});

test("a caller-supplied name that could rewrite a URL is refused before any dial", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const cases: readonly { readonly what: string; readonly work: () => Promise<unknown> }[] = [
		{ what: "owner traversal", work: () => port.createWorkRepo({ ...workRepoRequest, repository: "evil/../../other-org/target" }, "r") },
		{ what: "query in the repository name", work: () => port.createWorkRepo({ ...workRepoRequest, repository: "owner/repo?admin=1" }, "r") },
		{ what: "slash in the job id", work: () => port.createWorkRepo({ ...workRepoRequest, jobId: "job_7Q2K/../evil" as JobId }, "r") },
		{ what: "short commit", work: () => port.createWorkRepo({ ...workRepoRequest, frozenCommit: "a3b6ead" as CommitSha }, "r") },
		{ what: "commit with a query", work: () => port.publishVerified({ ...publishRequest, sourceCommit: "abc?ref=main" as CommitSha }, "r") },
		{ what: "query in the job id", work: () => port.publishVerified({ ...publishRequest, jobId: "job_7Q2K?x=1" as JobId }, "r") },
	];
	for (const item of cases) {
		const failure = await refusal(item.work());
		assert.equal(failure.code, "GITHUB_REQUEST_INVALID", item.what);
	}
	assert.deepEqual(stub.state.requests, []);
});

test("a boundary value that is not a string is refused by name, not crashed on", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	const cases: readonly { readonly what: string; readonly work: () => Promise<unknown> }[] = [
		{ what: "missing repository", work: () => port.createWorkRepo({ ...workRepoRequest, repository: null as unknown as string }, "r") },
		{ what: "object repository", work: () => port.createWorkRepo({ ...workRepoRequest, repository: {} as unknown as string }, "r") },
		{ what: "missing job id", work: () => port.createWorkRepo({ ...workRepoRequest, jobId: null as unknown as JobId }, "r") },
		{ what: "missing frozen commit", work: () => port.createWorkRepo({ ...workRepoRequest, frozenCommit: undefined as unknown as CommitSha }, "r") },
		{ what: "numeric frozen commit", work: () => port.createWorkRepo({ ...workRepoRequest, frozenCommit: 42 as unknown as CommitSha }, "r") },
		{ what: "missing source commit", work: () => port.publishVerified({ ...publishRequest, sourceCommit: null as unknown as CommitSha }, "r") },
		{ what: "missing check name", work: () => port.publishVerified({ ...publishRequest, checkName: undefined as unknown as string }, "r") },
	];
	for (const item of cases) {
		const failure = await refusal(item.work());
		assert.equal(failure.code, "GITHUB_REQUEST_INVALID", item.what);
	}
	assert.deepEqual(stub.state.requests, []);
});

test("a fork that answers 200 is not read as an adoption", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	stub.refuse({ method: "POST", path: `/repos/${CLIENT}/forks`, status: 200, message: "the repository exists" });
	const failure = await refusal(port.createWorkRepo(workRepoRequest, "req-1"));
	assert.equal(failure.code, "GITHUB_HTTP_ERROR");
	assert.equal(failure.status, 200);
	assert.deepEqual(repoMutations(stub), []);
});
