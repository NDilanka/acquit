// The App client and the fake answer the same port, so one set of assertions runs against both.
// The stub-only tests pin the wire behaviour the client owns: RS256 claims, header auth, one
// installation token per owner, idempotent adopt-or-create, and the named refusals.

import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createFakeGitHubApp, createGitHubApp } from "../src/github.ts";
import type { GitHubAppPort } from "../src/github.ts";
import type { CommitSha, JobId } from "../src/ids.ts";

const FROZEN = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const HEAD = "b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9";
const SUBMITTED = "c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1";
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
const CONFIG = { appId: APP_ID, privateKey, organization: ORG, timeoutMs: 5_000 };
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

type StubRepo = { full_name: string; name: string; owner: string; default_branch: string; fork: boolean };
type StubPull = { number: number; head: string; branch: string; state: string; title: string; body: string };
type StubCheck = { repo: string; id: number; name: string; head_sha: string; html_url: string };
type StubRequest = { readonly method: string; readonly path: string; readonly authorization: string };
type StubRefusal = { readonly method: string; readonly path: string; readonly status: number; readonly message: string; readonly headers: Record<string, string> };

type Stub = {
	readonly url: string;
	readonly state: {
		readonly repos: Map<string, StubRepo>;
		readonly refs: Map<string, string>;
		readonly commits: Map<string, Set<string>>;
		readonly pulls: StubPull[];
		readonly checks: StubCheck[];
		readonly mints: string[];
		readonly requests: StubRequest[];
		readonly forks: string[];
	};
	seed(repository: string, commits: readonly string[], refs: Record<string, string>): void;
	refuse(refusal: { method: string; path: string; status: number; message?: string; headers?: Record<string, string> }): void;
	hang(path: string): void;
	close(): Promise<void>;
};

/** A local stand-in for api.github.com: it verifies the App JWT, mints tokens, and keeps repo state. */
async function createGitHubStub(options: { readonly appId: string; readonly publicKey: string;
	readonly installations: readonly { readonly id: number; readonly account: string }[] }): Promise<Stub> {
	const state = { repos: new Map<string, StubRepo>(), refs: new Map<string, string>(), commits: new Map<string, Set<string>>(),
		pulls: [] as StubPull[], checks: [] as StubCheck[], mints: [] as string[], requests: [] as StubRequest[], forks: [] as string[] };
	const refusals: StubRefusal[] = [];
	const hangs: string[] = [];
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
	const authorize = (authorization: string): "app" | "installation" | null => {
		if (!authorization.startsWith("Bearer ")) return null;
		const value = authorization.slice("Bearer ".length);
		if (value.split(".").length === 3) return verifyJwt(value) ? "app" : null;
		return state.mints.includes(value) ? "installation" : null;
	};
	const segmentsOf = (path: string): string[] => path.split("?")[0]!.split("/").filter(Boolean);
	const route = (method: string, path: string, body: Record<string, unknown>, auth: "app" | "installation", response: ServerResponse): void => {
		const url = new URL(path, "http://stub");
		const segments = segmentsOf(path);
		const repository = segments.length >= 3 ? `${segments[1]}/${segments[2]}` : "";
		if (auth === "app" && method === "GET" && url.pathname === "/app/installations") {
			return json(response, 200, { total_count: options.installations.length,
				installations: options.installations.map(item => ({ id: item.id, account: { login: item.account, type: "Organization" } })) });
		}
		if (auth === "app" && method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
			const token = `ghs_${randomBytes(20).toString("hex")}`;
			state.mints.push(token);
			return json(response, 201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
		}
		if (method === "POST" && segments.length === 4 && segments[0] === "repos" && segments[3] === "forks") {
			const target = `${String(body.organization)}/${String(body.name)}`;
			if (state.repos.has(target)) return json(response, 422, { message: "Repository creation failed.",
				errors: [{ message: "name already exists on this account" }] });
			const created: StubRepo = { full_name: target, name: String(body.name), owner: String(body.organization), default_branch: "main", fork: true };
			state.repos.set(target, created);
			state.commits.set(target, new Set(state.commits.get(repository) ?? []));
			state.refs.set(`${target}:main`, state.refs.get(`${repository}:main`) ?? "");
			state.forks.push(`${repository}->${target}`);
			return json(response, 202, created);
		}
		if (segments[0] === "repos" && segments.length === 3) {
			const found = state.repos.get(repository);
			if (method === "GET") return found ? json(response, 200, found) : json(response, 404, { message: "Not Found" });
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
			const sha = state.refs.get(`${repository}:${refHead[1]}`);
			return sha === undefined ? json(response, 404, { message: "Not Found" })
				: json(response, 200, { ref: `refs/heads/${refHead[1]}`, object: { sha, type: "commit" } });
		}
		if (method === "POST" && segments.length === 5 && segments[3] === "git" && segments[4] === "refs") {
			const branch = String(body.ref).replace(/^refs\/heads\//, "");
			const sha = String(body.sha);
			if (!state.commits.get(repository)?.has(sha)) return json(response, 422, { message: "Reference update failed.",
				errors: [{ message: "Object does not exist" }] });
			state.refs.set(`${repository}:${branch}`, sha);
			return json(response, 201, { ref: String(body.ref), object: { sha, type: "commit" } });
		}
		const refPatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/);
		if (method === "PATCH" && refPatch) {
			state.refs.set(`${repository}:${refPatch[1]}`, String(body.sha));
			return json(response, 200, { ref: `refs/heads/${refPatch[1]}`, object: { sha: String(body.sha) } });
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
			if (state.pulls.some(pull => pull.head === head && pull.state === "open")) return json(response, 422,
				{ message: "Validation Failed", errors: [{ message: `A pull request already exists for ${head}` }] });
			const branch = head.includes(":") ? head.split(":")[1]! : head;
			const number = 100 + state.pulls.length;
			state.pulls.push({ number, head, branch: repository, state: "open", title: String(body.title), body: String(body.body ?? "") });
			return json(response, 201, { number, state: "open", title: String(body.title), body: String(body.body ?? ""),
				head: { label: head, ref: branch, sha: state.refs.get(`${repository}:${branch}`) ?? "" }, base: { ref: String(body.base) } });
		}
		if (method === "GET" && segments.length === 6 && segments[3] === "commits" && segments[5] === "check-runs") {
			const sha = segments[4];
			const name = url.searchParams.get("check_name") ?? "";
			const items = state.checks.filter(run => run.repo === repository && run.head_sha === sha && (name === "" || run.name === name));
			return json(response, 200, { total_count: items.length, check_runs: items });
		}
		if (method === "POST" && segments.length === 4 && segments[3] === "check-runs") {
			const name = String(body.name);
			const headSha = String(body.head_sha);
			if (state.checks.some(run => run.repo === repository && run.name === name && run.head_sha === headSha)) {
				return json(response, 422, { message: "Check run already exists" });
			}
			const run: StubCheck = { repo: repository, id: state.checks.length + 1, name, head_sha: headSha,
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
			state.requests.push({ method: request.method ?? "", path, authorization });
			if (hangs.some(prefix => path.startsWith(prefix))) return;
			const refused = refusals.find(item => item.method === request.method && path.startsWith(item.path));
			if (refused) return json(response, refused.status, { message: refused.message }, refused.headers);
			const auth = authorize(authorization);
			if (auth === null) return json(response, 401, { message: "A JSON web token could not be decoded" });
			const body = Buffer.concat(chunks).length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			route(request.method ?? "", path, body, auth, response);
		})().catch(error => { json(response, 500, { message: String(error) }); });
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		state,
		seed(repository, commits, refs) {
			state.repos.set(repository, { full_name: repository, name: repository.split("/")[1]!, owner: repository.split("/")[0]!,
				default_branch: "main", fork: false });
			state.commits.set(repository, new Set(commits));
			for (const [branch, sha] of Object.entries(refs)) state.refs.set(`${repository}:${branch}`, sha);
		},
		refuse(item) { refusals.push({ method: item.method, path: item.path, status: item.status,
			message: item.message ?? "refused by the stub", headers: item.headers ?? {} }); },
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

	test(`two jobs on one client repo get their own work repo and pull request (${harness.name})`, async t => {
		const app = await harness.make();
		t.after(app.close);
		const first = await app.port.publishVerified(publishRequest, "req-1");
		const second = await app.port.publishVerified({ ...publishRequest, jobId: OTHER_JOB }, "req-2");
		assert.notEqual(second.pullRequest, first.pullRequest);
		assert.equal(second.repository, CLIENT);
	});
}

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
		for (const token of stub.state.mints) assert.equal(request.path.includes(token), false, request.path);
	}
	const installationCalls = stub.state.requests.filter(request => request.path.startsWith("/repos/"));
	assert.ok(installationCalls.every(request => stub.state.mints.includes(request.authorization.slice("Bearer ".length))));
});

test("one installation token per owner is minted and reused for later calls", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	await port.publishVerified(publishRequest, "req-2");
	assert.equal(stub.state.mints.length, 2);
	assert.equal(stub.state.requests.filter(request => request.method === "GET" && request.path.startsWith("/app/installations")).length, 1);
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

test("a verified commit the client repo does not have becomes a fork pull request", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	// The submitter pushed its commit to the work fork, so the client repo has no such object.
	stub.state.commits.get(WORK_REPO)?.add(SUBMITTED);
	const published = await port.publishVerified({ ...publishRequest, sourceCommit: SUBMITTED as CommitSha }, "req-2");
	assert.equal(stub.state.refs.get(`${WORK_REPO}:acquit/${JOB}`), SUBMITTED);
	assert.equal(stub.state.pulls.at(0)?.head, `${ORG}:acquit/${JOB}`);
	assert.equal(stub.state.checks.at(0)?.repo, WORK_REPO);
	assert.equal(published.mergeCommit, SUBMITTED);
});

test("an existing ref at another commit is refused and never moved", async t => {
	const { port, stub, close } = await withStub();
	t.after(close);
	await port.createWorkRepo(workRepoRequest, "req-1");
	const failure = await refusal(port.createWorkRepo({ ...workRepoRequest, frozenCommit: SUBMITTED as CommitSha }, "req-2"));
	assert.equal(failure.code, "GITHUB_REF_CONFLICT");
	assert.match(failure.detail, new RegExp(FROZEN));
	assert.equal(stub.state.refs.get(`${WORK_REPO}:main`), FROZEN);
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
