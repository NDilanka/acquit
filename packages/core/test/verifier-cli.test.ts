// The CLI prints what docs/tutorial.md shows, character for character, from a fixed API reply.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CommitSha, JobId, OperatorId } from "../src/ids.ts";
import type { JobProjection } from "../src/job.ts";
import { CliError } from "../../acquit-cli/src/client.ts";
import type { ApiClient } from "../../acquit-cli/src/client.ts";
import { main } from "../../acquit-cli/src/main.ts";
import { localHead, parseSubmitArgs, renderSubmission, runSubmit } from "../../acquit-cli/src/submit.ts";

const frozenAt = "a41c9e2" as CommitSha;
const submitted = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const workRepo = "acquit-forks/invoice-app-7Q2K";
const workRepoToken = "ghs_CANARY_WORK_REPO_TOKEN";

/** The projection the API answers with after attempt 1 on the tamper-test branch. */
function rejectedView(): JobProjection {
	return {
		id: "job_7Q2K" as JobId, title: "Totals round wrong for 3-decimal currencies", status: "IN_PROGRESS", phase: "READY",
		budget: 40000, deliveryEndsAt: "2026-11-08T10:00:00.000Z", contract: { repository: "maya-client/invoice-app",
			frozenAt, frozenTests: 48, hiddenTests: 6, protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"] },
		bids: { operators: [], house: null }, lockedTo: "devon-ops" as OperatorId, escrow: "HELD",
		approveUrl: null, ledger: [], attempts: { used: 1, left: 2, last: "REJECTED", reasons: ["PR modifies frozen test file tests/totals.test.ts"],
			history: [{ ordinal: 1, result: "REJECTED", reasons: ["PR modifies frozen test file tests/totals.test.ts"], sourceCommit: submitted,
				at: "2026-11-08T09:12:00.000Z", frozen: null, hidden: null, pullRequest: null }], pending: null },
		reviewEndsAt: null, pullRequest: null, receipt: null,
	} as unknown as JobProjection;
}

/** The projection after attempt 2 on fix-honest. */
function verifiedView(): JobProjection {
	const view = rejectedView();
	return { ...view, status: "VERIFIED", phase: "AWAITING_CLIENT", lockedTo: null,
		attempts: { used: 2, left: 1, last: "VERIFIED", reasons: [],
			history: [
				{ ...view.attempts.history[0], sourceCommit: "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha },
				{ ordinal: 2, result: "VERIFIED", reasons: [], sourceCommit: submitted, at: "2026-11-08T09:20:00.000Z",
					frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, pullRequest: 13 },
			], pending: null },
		reviewEndsAt: "2026-11-11T09:20:00.000Z", pullRequest: 13 } as unknown as JobProjection;
}

const noHandles = () => null;

test("the REJECTED block matches docs/tutorial.md character for character", () => {
	assert.equal(renderSubmission(rejectedView(), noHandles, "2026-11-08T09:12:00.000Z"), [
		"Submitted job_7Q2K (attempt 1 of 3)",
		"Verifier result: REJECTED",
		"\tPR modifies frozen test file tests/totals.test.ts",
		"Job status: IN_PROGRESS",
		"Escrow: HELD, locked to devon-ops",
		"Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.",
	].join("\n"));
});

test("the VERIFIED block matches docs/tutorial.md character for character", () => {
	// The verdict's own instant is the API clock the CLI reads it with, so the window is the full 72 hours.
	assert.equal(renderSubmission(verifiedView(), noHandles, "2026-11-08T09:20:00.000Z"), [
		"Submitted job_7Q2K (attempt 2 of 3)",
		"Verifier result: VERIFIED",
		"\tFrozen tests: 48 passed (suite frozen at a41c9e2)",
		"\tHidden tests: 6 passed",
		"\tRequired tests: 54 completed, 0 skipped or missing",
		"\tProtected paths: none touched",
		"Pull request opened: maya-client/invoice-app#13",
		"Job status: VERIFIED",
		"Client review window: 72 hours",
	].join("\n"));
});

test("the VERIFIED block refuses a projection with no frozen contract by name", () => {
	assert.throws(() => renderSubmission({ ...verifiedView(), contract: null }, noHandles, "2026-11-08T09:20:00.000Z"),
		(error: CliError) => error.code === "CONTRACT_NOT_FROZEN");
});

test("submit parses its flags, refuses unknown ones, and never prints a token", () => {
	const options = parseSubmitArgs(["job_7Q2K", "--dir", "/tmp/work", "--remote", "origin", "--timeout", "30"], { ACQUIT_TOKEN: "s3cret" });
	assert.deepEqual({ jobId: options.jobId, dir: options.dir, remote: options.remote, timeoutSeconds: options.timeoutSeconds,
		apiUrl: options.apiUrl, token: options.token }, { jobId: "job_7Q2K", dir: "/tmp/work", remote: "origin", timeoutSeconds: 30,
		apiUrl: "http://127.0.0.1:4310", token: "s3cret" });
	assert.throws(() => parseSubmitArgs(["--nope"], { ACQUIT_TOKEN: "s3cret" }), (error: CliError) => error.code === "USAGE");
	assert.throws(() => parseSubmitArgs(["job_7Q2K"], {}), (error: CliError) => error.code === "AUTH_REQUIRED" && !error.message.includes("s3cret"));
	assert.throws(() => parseSubmitArgs([], { ACQUIT_TOKEN: "s3cret" }), (error: CliError) => error.code === "USAGE");
});

test("the session token never comes from argv: --token reads stdin and a value is refused", () => {
	const canary = "canary-token-value";
	assert.throws(() => parseSubmitArgs(["job_7Q2K", "--token", canary], { ACQUIT_TOKEN: "s3cret" }),
		(error: CliError) => error.code === "TOKEN_ON_ARGV" && !error.message.includes(canary));
	assert.equal(parseSubmitArgs(["job_7Q2K", "--token"], {}, () => `${canary}\n`).token, canary);
	assert.equal(parseSubmitArgs(["job_7Q2K", "--token"], { ACQUIT_TOKEN: "s3cret" }, () => "stdin-token\n").token, "stdin-token");
	assert.throws(() => parseSubmitArgs(["job_7Q2K", "--token"], {}, () => "\n"), (error: CliError) => error.code === "AUTH_REQUIRED");
});

test("localHead refuses a directory that is not a repository", () => {
	assert.throws(() => localHead("/tmp", undefined, { XDG_STATE_HOME: join(tmpdir(), `acquit-head-none-${process.pid}`) }),
		(error: CliError) => error.code === "NOT_A_REPOSITORY");
});

test("a push to a work repo funding has not created yet is refused by name", async () => {
	const { pushError } = await import("../../acquit-cli/src/submit.ts") as { pushError?: (remote: string, stderr: string) => CliError };
	assert.equal(typeof pushError, "function");
	const missing = pushError!("https://github.com/acquit-forks/invoice-app-7Q2K.git",
		"remote: Repository not found.\nfatal: repository 'https://github.com/acquit-forks/invoice-app-7Q2K.git/' not found");
	assert.equal(missing.code, "WORK_REPO_NOT_READY");
	assert.match(missing.message, /created shortly after funding/);
	assert.match(missing.message, /about 30 seconds/);
	const other = pushError!("origin", "error: failed to push some refs to 'origin'");
	assert.equal(other.code, "PUSH_REFUSED");
});
test("a push refusal names both causes of a missing work repo and repeats no credential", async () => {
	const { pushError } = await import("../../acquit-cli/src/submit.ts") as { pushError?: (remote: string, stderr: string) => CliError };
	assert.equal(typeof pushError, "function");
	const token = `ghp_${"S".repeat(36)}`;
	const remote = `https://x-access-token:${token}@github.com/acquit-forks/invoice-app-7Q2K.git`;
	const missing = pushError!(remote, "remote: Repository not found.\nfatal: failed to push some refs");
	assert.equal(missing.code, "WORK_REPO_NOT_READY");
	assert.match(missing.message, /created shortly after funding/);
	assert.match(missing.message, /about 30 seconds/);
	assert.match(missing.message, /credential cannot see the private repo/);
	assert.match(missing.message, /App installation on the org/);
	assert.equal(missing.message.includes(token), false, missing.message);
	assert.equal(missing.message.includes("x-access-token"), false, missing.message);
	const escaped = pushError!("origin", "remote: \u001b[2K\u001b[1Goverwritten by the remote\nfatal: failed to push some refs to 'origin'");
	assert.equal(escaped.code, "PUSH_REFUSED");
	assert.equal(/[\u0000-\u001f\u007f]/.test(escaped.message), false, JSON.stringify(escaped.message));
	assert.equal(escaped.message.includes("overwritten by the remote"), true, escaped.message);
});

test("each submission lands on its own commit-named ref and never moves the publisher's branch", async () => {
	const { pushHead } = await import("../../acquit-cli/src/submit.ts") as { pushHead?: (dir: string, remote: string, commit: CommitSha,
		env?: NodeJS.ProcessEnv, scoped?: { readonly gitDir: string | null }) => void };
	assert.equal(typeof pushHead, "function");
	const root = mkdtempSync(join(tmpdir(), "acquit-push-sibling-"));
	try {
		const stateHome = join(root, "state-home");
		const work = join(root, "work");
		const remote = join(root, "invoice-app-7Q2K.git");
		mkdirSync(work);
		const git = (dir: string, args: readonly string[]) => {
			const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
			if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
			return result.stdout.trim();
		};
		git(root, ["init", "--bare", "--quiet", remote]);
		git(work, ["init", "--quiet"]);
		git(work, ["config", "user.email", "fixture@example.invalid"]);
		git(work, ["config", "user.name", "fixture"]);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 2;\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "--quiet", "-m", "frozen"]);
		const frozen = git(work, ["rev-parse", "HEAD"]);
		// The work repo carries main at the frozen commit, as funding creates it. The publisher's
		// branch already exists on top, as it would after a verified run. Both submissions below
		// must leave it where it is.
		git(work, ["push", "--quiet", remote, `${frozen}:refs/heads/main`]);
		git(remote, ["update-ref", "refs/heads/acquit/job_7Q2K", frozen]);
		// Attempt 1 is the tamper. Attempt 2 is built from the frozen commit, so the two are siblings.
		writeFileSync(join(work, "tests.ts"), "expect(1).toBe(2);\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "--quiet", "-m", "tamper"]);
		const rejected = git(work, ["rev-parse", "HEAD"]);
		pushHead!(work, remote, rejected as CommitSha, { XDG_STATE_HOME: stateHome });
		git(work, ["checkout", "--quiet", "--detach", frozen]);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 3;\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "--quiet", "-m", "fix"]);
		const fix = git(work, ["rev-parse", "HEAD"]);
		pushHead!(work, remote, fix as CommitSha, { XDG_STATE_HOME: stateHome });
		// The ref is content-addressed, so the same commit pushed twice is an up-to-date no-op.
		pushHead!(work, remote, fix as CommitSha, { XDG_STATE_HOME: stateHome });
		assert.equal(git(remote, ["rev-parse", `refs/heads/submissions/${rejected}`]), rejected);
		assert.equal(git(remote, ["rev-parse", `refs/heads/submissions/${fix}`]), fix);
		assert.equal(git(remote, ["rev-parse", "refs/heads/acquit/job_7Q2K"]), frozen,
			"pushHead must neither create nor move the publisher's branch");
		assert.equal(spawnSync("git", ["-C", remote, "cat-file", "-e", `${rejected}^{commit}`]).status, 0,
			"the rejected commit must have reached the work repo");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a scoped push ignores a planted hook and refuses dangerous config on an operator checkout", async () => {
	const { pushHead, localHead } = await import("../../acquit-cli/src/submit.ts") as { pushHead?: (dir: string, remote: string, commit: CommitSha,
		env?: NodeJS.ProcessEnv, scoped?: { readonly gitDir: string | null; readonly askpass?: NodeJS.ProcessEnv }) => void;
		localHead?: (dir: string, jobId?: string, env?: NodeJS.ProcessEnv) => CommitSha };
	assert.equal(typeof pushHead, "function");
	const root = mkdtempSync(join(tmpdir(), "acquit-push-scoped-"));
	try {
		const stateHome = join(root, "state-home");
		const env = { PATH: process.env.PATH, XDG_STATE_HOME: stateHome };
		const work = join(root, "work");
		const remote = join(root, "invoice-app-7Q2K.git");
		mkdirSync(work);
		const git = (dir: string, args: readonly string[]) => {
			const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
			if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
			return result.stdout.trim();
		};
		git(root, ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
		git(work, ["init", "--quiet"]);
		git(work, ["config", "user.email", "fixture@example.invalid"]);
		git(work, ["config", "user.name", "fixture"]);
		writeFileSync(join(work, "money.ts"), "const DECIMALS = 2;\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "--quiet", "-m", "frozen"]);
		const frozen = git(work, ["rev-parse", "HEAD"]);
		git(work, ["push", "--quiet", remote, `${frozen}:refs/heads/main`]);
		// The operator's own checkout: no state git directory exists, so the scoped push resolves the
		// checkout's git directory itself. A hook planted there must never run. The askpass stands in
		// for the credential the API mints for the work repo.
		const canary = join(root, "hook-ran");
		const scoped = { gitDir: null, askpass: { GIT_ASKPASS: "/bin/true" } } as const;
		mkdirSync(join(work, ".git", "hooks"), { recursive: true });
		writeFileSync(join(work, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
		pushHead!(work, remote, frozen as CommitSha, env, scoped);
		assert.equal(existsSync(canary), false);
		assert.equal(git(remote, ["rev-parse", `refs/heads/submissions/${frozen}`]), frozen);
		// Config the CLI did not write is refused before git can read it, even on the operator's own
		// checkout: the scoped token must never meet an untrusted credential or URL rewrite.
		git(work, ["config", "--local", "credential.helper", "store"]);
		assert.throws(() => pushHead!(work, remote, frozen as CommitSha, env, scoped),
			(error: CliError) => error.code === "GIT_CONFIG_UNSAFE" && error.message.includes("credential.helper"));
		// The same checkout pushed with the operator's own credential keeps that config: it is theirs,
		// so the checkout's own pre-push hook runs as the operator's own git would run it.
		pushHead!(work, remote, frozen as CommitSha, env, { gitDir: null });
		assert.equal(existsSync(canary), true);
		git(work, ["config", "--local", "--unset", "credential.helper"]);
		// A state checkout names the state git directory explicitly; plain discovery from the work tree
		// never finds it, and the same planted metadata is ignored.
		const state = join(stateHome, "acquit", "work", "job_7Q2K.git");
		mkdirSync(dirname(state), { recursive: true });
		git(root, ["clone", "--quiet", "--separate-git-dir", state, remote, join(root, "state-work")]);
		assert.equal(localHead!(join(root, "state-work"), "job_7Q2K", env), frozen);
		rmSync(join(root, "state-work", ".git"), { force: true });
		mkdirSync(join(root, "state-work", ".git"));
		writeFileSync(join(root, "state-work", ".git", "config"), `[url "https://evil.example/"]\n\tinsteadOf = ${remote}\n`);
		assert.equal(spawnSync("git", ["-C", join(root, "state-work"), "rev-parse", "HEAD"]).status !== 0, true);
		writeFileSync(join(root, "state-work", "fix.ts"), "export const fixed = true;\n");
		pushHead!(join(root, "state-work"), remote, frozen as CommitSha, env, { gitDir: state, askpass: { GIT_ASKPASS: "/bin/true" } });
		assert.equal(git(remote, ["rev-parse", `refs/heads/submissions/${frozen}`]), frozen);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runSubmit polls until the submitted commit is judged and prints the block", async () => {
	const calls: string[] = [];
	let polls = 0;
	const client: ApiClient = { baseUrl: "http://api.test",
		async get(path) { calls.push(`GET ${path}`); polls++;
			return { job: polls === 1 ? rejectedView() : verifiedView(), handles: { "devon-ops": "devon-ops" } }; },
		async post(path, payload) { calls.push(`POST ${path} ${JSON.stringify(payload)}`);
			return path.endsWith("/work-repo-token")
				? { status: 200, body: { repository: workRepo, token: workRepoToken } }
				: { status: 200, body: { outcome: { kind: "COMMITTED" } } }; } };
	const printed = await runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted, push: () => {}, sleep: async () => {} });
	assert.match(printed, /Verifier result: VERIFIED/);
	assert.match(printed, /Pull request opened: maya-client\/invoice-app#13/);
	const payload = JSON.parse(calls[2].slice("POST /api/commands ".length)) as { key: string; command: unknown };
	assert.match(payload.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.deepEqual(payload.command, { type: "Submit", jobId: "job_7Q2K", sourceCommit: submitted });
	assert.equal(calls.filter(call => call.startsWith("GET /api/jobs/")).length, 2);
});

test("a submit pushes through the credential the API mints for the job's work repo", async () => {
	const posts: string[] = [];
	const pushes: { remote: string; env: NodeJS.ProcessEnv | undefined; scoped: { gitDir: string | null; askpass?: NodeJS.ProcessEnv } }[] = [];
	let tokenFile: string | null = null;
	let tokenSeen = "";
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { return { job: rejectedView(), handles: {} }; },
		async post(path) {
			posts.push(path);
			return path.endsWith("/work-repo-token")
				? { status: 200, body: { repository: workRepo, token: workRepoToken } }
				: { status: 200, body: { outcome: { kind: "COMMITTED" } } };
		} };
	await runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted,
		env: { XDG_STATE_HOME: join(tmpdir(), `acquit-submit-none-${process.pid}`) },
		push: (dir, remote, commit, env, scoped) => {
			pushes.push({ remote, env, scoped: scoped ?? { gitDir: null } });
			// The askpass script names its own token file; no token-path variable is in the environment.
			tokenFile = /cat '([^']*)'/.exec(readFileSync(String(scoped?.askpass?.GIT_ASKPASS ?? ""), "utf8"))?.[1] ?? null;
			tokenSeen = tokenFile === null ? "" : readFileSync(tokenFile, "utf8").trim();
		}, sleep: async () => {} });
	assert.deepEqual(posts, ["/api/jobs/job_7Q2K/work-repo-token", "/api/commands"]);
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].remote, "https://github.com/acquit-forks/invoice-app-7Q2K.git");
	assert.equal(pushes[0].scoped.askpass?.GIT_ASKPASS !== undefined, true);
	assert.equal(pushes[0].scoped.askpass?.ACQUIT_RUN_TOKEN_FILE, undefined);
	assert.equal(pushes[0].scoped.gitDir, null, "no state git directory exists for /tmp/work");
	assert.equal(pushes[0].env?.GIT_ASKPASS, undefined, "the askpass is not part of the inherited environment");
	assert.equal(pushes[0].remote.includes(workRepoToken), false);
	assert.equal(Object.values(pushes[0].env ?? {}).some(value => String(value).includes(workRepoToken)), false);
	assert.equal(tokenSeen, workRepoToken);
	assert.equal(tokenFile !== null && existsSync(dirname(tokenFile)), false, "the secret directory must be removed");
});

test("--remote origin that resolves to the job's work repo mints the same scoped credential", async () => {
	const posts: string[] = [];
	const pushes: string[] = [];
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { return { job: rejectedView(), handles: {} }; },
		async post(path) {
			posts.push(path);
			return path.endsWith("/work-repo-token")
				? { status: 200, body: { repository: workRepo, token: workRepoToken } }
				: { status: 200, body: { outcome: { kind: "COMMITTED" } } };
		} };
	await runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: "origin", apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted,
		remoteUrl: () => "https://github.com/acquit-forks/invoice-app-7Q2K.git",
		push: (dir, remote) => pushes.push(remote), sleep: async () => {} });
	assert.deepEqual(posts, ["/api/jobs/job_7Q2K/work-repo-token", "/api/commands"]);
	assert.deepEqual(pushes, ["https://github.com/acquit-forks/invoice-app-7Q2K.git"]);
});

test("a remote that is not the job's work repo keeps the operator's own credential", async () => {
	const run = async (remote: string, resolved: string | null) => {
		const posts: string[] = [];
		const pushes: string[] = [];
		const client: ApiClient = { baseUrl: "http://api.test",
			async get() { return { job: rejectedView(), handles: {} }; },
			async post(path) {
				posts.push(path);
				return { status: 200, body: { outcome: { kind: "COMMITTED" } } };
			} };
		await runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote, apiUrl: "http://api.test", token: "s3cret",
			timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted, remoteUrl: () => resolved,
			push: (dir, named) => pushes.push(named), sleep: async () => {} });
		return { posts, pushes };
	};
	// A named remote that resolves elsewhere, and a URL the operator named: neither mints.
	const named = await run("origin", "https://github.com/maya-client/invoice-app.git");
	assert.deepEqual(named.posts, ["/api/commands"]);
	assert.deepEqual(named.pushes, ["origin"]);
	const other = await run("https://github.com/someone/other.git", null);
	assert.deepEqual(other.posts, ["/api/commands"]);
	assert.deepEqual(other.pushes, ["https://github.com/someone/other.git"]);
});

test("a denied submit names the operator the job is locked to", async () => {
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { return { job: rejectedView(), handles: { "devon-ops": "devon-ops" } }; },
		async post(path) { return path.endsWith("/work-repo-token")
			? { status: 200, body: { repository: workRepo, token: workRepoToken } }
			: { status: 409, body: { outcome: { kind: "DENIED", reason: "NOT_OWNER" } } }; } };
	await assert.rejects(() => runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted, push: () => {} }),
		(error: CliError) => error.code === "NOT_OWNER" && error.message.includes("locked to devon-ops"));
});

test("a mint refused to a stranger leaves the denial to the Submit command", async () => {
	const run = async (remote: string | null) => {
		const posts: string[] = [];
		const pushes: string[] = [];
		const client: ApiClient = { baseUrl: "http://api.test",
			async get() { return { job: rejectedView(), handles: { "devon-ops": "devon-ops" } }; },
			async post(path) {
				posts.push(path);
				if (path.endsWith("/work-repo-token")) throw new CliError("NOT_OWNER", "Job job_7Q2K is not locked to this operator.");
				return { status: 409, body: { outcome: { kind: "DENIED", reason: "NOT_OWNER" } } };
			} };
		await assert.rejects(() => runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote, apiUrl: "http://api.test", token: "s3cret",
			timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted,
			remoteUrl: () => "https://github.com/acquit-forks/invoice-app-7Q2K.git",
			push: (dir, named) => pushes.push(named) }),
			(error: CliError) => error.code === "NOT_OWNER" && error.message.includes("locked to devon-ops"));
		return { posts, pushes };
	};
	// The default push has nowhere to fall back to; a named work-repo remote falls back to the
	// operator's own credential, which is what today's push did.
	const fallback = await run(null);
	assert.deepEqual(fallback.posts, ["/api/jobs/job_7Q2K/work-repo-token", "/api/commands"]);
	assert.deepEqual(fallback.pushes, []);
	const named = await run("origin");
	assert.deepEqual(named.posts, ["/api/jobs/job_7Q2K/work-repo-token", "/api/commands"]);
	assert.deepEqual(named.pushes, ["origin"]);
});

test("a mint that is not ready or not configured falls back for a named remote and surfaces for the default", async () => {
	const noState = { XDG_STATE_HOME: join(tmpdir(), `acquit-submit-none-${process.pid}`) };
	const run = async (remote: string | null, code: string, detail: string) => {
		const posts: string[] = [];
		const pushes: string[] = [];
		const client: ApiClient = { baseUrl: "http://api.test",
			async get() { return { job: rejectedView(), handles: {} }; },
			async post(path) {
				posts.push(path);
				if (path.endsWith("/work-repo-token")) throw new CliError(code, detail);
				return { status: 200, body: { outcome: { kind: "COMMITTED" } } };
			} };
		try {
			await runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote, apiUrl: "http://api.test", token: "s3cret",
				timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted, env: noState,
				remoteUrl: () => "https://github.com/acquit-forks/invoice-app-7Q2K.git",
				push: (dir, named) => pushes.push(named), sleep: async () => {} });
			return { error: null as CliError | null, posts, pushes };
		} catch (error) {
			assert.equal(error instanceof CliError, true);
			return { error: error as CliError, posts, pushes };
		}
	};
	const retry = "The work repository acquit-forks/invoice-app-7Q2K is not visible to the GitHub App yet. "
		+ "It is created shortly after funding, so retry in about 30 seconds.";
	// A named work-repo remote keeps the operator's own credential, the way submit pushed before the
	// scoped mint existed; the Submit command still runs.
	const namedNotReady = await run("origin", "WORK_REPO_NOT_READY", retry);
	assert.deepEqual(namedNotReady.posts, ["/api/jobs/job_7Q2K/work-repo-token", "/api/commands"]);
	assert.deepEqual(namedNotReady.pushes, ["origin"]);
	const namedUnconfigured = await run("origin", "GITHUB_NOT_CONFIGURED", "Set ACQUIT_GITHUB_APP_ID, ACQUIT_GITHUB_APP_PRIVATE_KEY, and ACQUIT_GITHUB_APP_ORG before a run.");
	assert.deepEqual(namedUnconfigured.posts, ["/api/jobs/job_7Q2K/work-repo-token", "/api/commands"]);
	assert.deepEqual(namedUnconfigured.pushes, ["origin"]);
	// The default target has no operator credential to fall back to: the refusal surfaces with its
	// retry hint instead of a Submit the API would refuse.
	const defaultNotReady = await run(null, "WORK_REPO_NOT_READY", retry);
	assert.equal(defaultNotReady.error?.code, "WORK_REPO_NOT_READY");
	assert.match(defaultNotReady.error?.message ?? "", /retry in about 30 seconds/);
	assert.deepEqual(defaultNotReady.posts, ["/api/jobs/job_7Q2K/work-repo-token"]);
	const defaultUnconfigured = await run(null, "GITHUB_NOT_CONFIGURED", "Set ACQUIT_GITHUB_APP_ID, ACQUIT_GITHUB_APP_PRIVATE_KEY, and ACQUIT_GITHUB_APP_ORG before a run.");
	assert.equal(defaultUnconfigured.error?.code, "GITHUB_NOT_CONFIGURED");
	assert.deepEqual(defaultUnconfigured.posts, ["/api/jobs/job_7Q2K/work-repo-token"]);
	// A mint that failed for any other reason is never papered over with another credential.
	const tokenFailed = await run("origin", "WORK_REPO_TOKEN_FAILED", "GitHub refused a credential for the work repo.");
	assert.equal(tokenFailed.error?.code, "WORK_REPO_TOKEN_FAILED");
	assert.deepEqual(tokenFailed.posts, ["/api/jobs/job_7Q2K/work-repo-token"]);
	assert.deepEqual(tokenFailed.pushes, []);
});

test("a run that never reports ends in a named timeout, not a hang", async () => {
	let now = 0;
	const view = rejectedView();
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { return { job: { ...view, attempts: { ...view.attempts, history: [],
			pending: { ordinal: 1, run: 1, runId: "run_job_7Q2K_1", sourceCommit: submitted, submittedAt: "2026-11-08T09:12:00.000Z",
				runEndsAt: "2026-11-08T09:42:00.000Z" } } }, handles: {} }; },
		async post(path) { return path.endsWith("/work-repo-token")
			? { status: 200, body: { repository: workRepo, token: workRepoToken } }
			: { status: 200, body: { outcome: { kind: "COMMITTED" } } }; } };
	await assert.rejects(() => runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 1, pollMs: 1 }, { client, head: () => submitted, push: () => {}, sleep: async () => { now += 2_000; }, now: () => now }),
		(error: CliError) => error.code === "VERIFIER_TIMEOUT" && error.message.includes("2026-11-08 09:42 UTC"));
});

test("a run that ends without a verdict prints its named reason instead of waiting for the deadline", async () => {
	const clean = rejectedView();
	const failed = { ...clean, attempts: { used: 0, left: 3, last: null, reasons: [], history: [], pending: null,
		failure: { runId: "run_job_7Q2K_1", sourceCommit: submitted, name: "PUBLISH_FAILED", detail: "no App installation on maya-client",
			at: "2026-11-08T09:12:01.000Z" } } } as unknown as JobProjection;
	let polls = 0;
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { polls++; return { job: polls === 1 ? clean : failed, handles: {} }; },
		async post(path) { return path.endsWith("/work-repo-token")
			? { status: 200, body: { repository: workRepo, token: workRepoToken } }
			: { status: 200, body: { outcome: { kind: "COMMITTED" } } }; } };
	await assert.rejects(() => runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 180, pollMs: 1 }, { client, head: () => submitted, push: () => {}, sleep: async () => {} }),
		(error: CliError) => error.code === "RUN_FAILED" && error.message === "PUBLISH_FAILED: no App installation on maya-client");
	// One read before the Submit, one poll after it: the failure ends the wait, not the run deadline.
	assert.equal(polls, 2);
});

test("a failure the job already carried for this commit does not stop the wait for the new run", async () => {
	const stale = { ...rejectedView(), attempts: { used: 0, left: 3, last: null, reasons: [], history: [],
		failure: { runId: "run_job_7Q2K_1", sourceCommit: submitted, name: "SOURCE_UNAVAILABLE", detail: "gone", at: "2026-11-08T09:00:00.000Z" },
		pending: { ordinal: 1, run: 2, runId: "run_job_7Q2K_2", sourceCommit: submitted, submittedAt: "2026-11-08T09:12:00.000Z",
			runEndsAt: "2026-11-08T09:42:00.000Z" } } } as unknown as JobProjection;
	let polls = 0;
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { polls++; return { job: polls === 1 ? stale : verifiedView(), handles: { "devon-ops": "devon-ops" } }; },
		async post(path) { return path.endsWith("/work-repo-token")
			? { status: 200, body: { repository: workRepo, token: workRepoToken } }
			: { status: 200, body: { outcome: { kind: "COMMITTED" } } }; } };
	const printed = await runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted, push: () => {}, sleep: async () => {} });
	assert.match(printed, /Verifier result: VERIFIED/);
	assert.equal(polls, 2);
});

test("the handle the block prints comes from the API, never from the id", () => {
	const at = "2026-11-08T09:12:00.000Z";
	assert.equal(renderSubmission(rejectedView(), () => "devon-ops", at), renderSubmission(rejectedView(), () => "devon-ops", at));
	assert.match(renderSubmission(rejectedView(), () => "someone-else", at), /Escrow: HELD, locked to someone-else/);
	assert.match(renderSubmission(rejectedView(), () => null, at), /Escrow: HELD, locked to devon-ops/);
});

test("the real CLI prints the child-subject refusal by name and exits 1 without a stack", () => {
	const cli = fileURLToPath(new URL("../../acquit-cli/src/main.ts", import.meta.url));
	const submit = (subject: string) => spawnSync(process.execPath, [cli, "submit", "job_7Q2K"],
		{ encoding: "utf8", env: { ...process.env, ACQUIT_VERIFIER_SUBJECT: subject, ACQUIT_DEV: "0" } });
	const child = submit("child");
	assert.equal(child.status, 1);
	assert.equal(child.stdout, "");
	assert.match(child.stderr, /^acquit: SUBJECT_CHILD_REFUSED: The child-process subject is the unit-test path only\./);
	assert.equal(child.stderr.trimEnd().split("\n").length, 1);
	const unknown = submit("chroot");
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /^acquit: SUBJECT_CHILD_REFUSED: Unknown subject chroot\./);
	assert.equal(unknown.stderr.trimEnd().split("\n").length, 1);
});

test("main prints usage, refuses an unknown command, and reports a refusal without a stack", async () => {
	const lines: string[] = [];
	const errors: string[] = [];
	const original = { log: console.log, error: console.error };
	console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
	console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
	try {
		assert.equal(await main([], {}), 2);
		assert.match(lines[0], /^acquit — work the job board/);
		assert.equal(await main(["--help"], {}), 0);
		// `diff` is a known command, so it asks for a token; a command this build does not carry exits 2.
		assert.equal(await main(["verify", "job_7Q2K"], {}), 2);
		assert.equal(await main(["diff", "job_7Q2K"], {}), 1);
		assert.equal(await main(["submit", "job_7Q2K"], {}), 1);
		assert.match(errors.at(-1) ?? "", /^acquit: AUTH_REQUIRED: /);
		assert.equal(lines.some(line => line.includes("s3cret")), false);
	} finally { console.log = original.log; console.error = original.error; }
});
