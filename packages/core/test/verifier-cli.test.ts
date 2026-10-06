// The CLI prints what docs/tutorial.md shows, character for character, from a fixed API reply.

import assert from "node:assert/strict";
import test from "node:test";
import type { CommitSha, JobId, OperatorId } from "../src/ids.ts";
import type { JobProjection } from "../src/job.ts";
import { CliError } from "../../acquit-cli/src/client.ts";
import type { ApiClient } from "../../acquit-cli/src/client.ts";
import { main } from "../../acquit-cli/src/main.ts";
import { localHead, parseSubmitArgs, renderSubmission, runSubmit } from "../../acquit-cli/src/submit.ts";

const frozenAt = "a41c9e2" as CommitSha;
const submitted = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;

/** The projection the API answers with after attempt 1 on the tamper-test branch. */
function rejectedView(): JobProjection {
	return {
		id: "job_7Q2K" as JobId, title: "Totals round wrong for 3-decimal currencies", status: "IN_PROGRESS", phase: "READY",
		budget: 40000, deliveryEndsAt: "2026-11-08T10:00:00.000Z", contract: { repository: "maya-client/invoice-app",
			frozenAt, frozenTests: 48, hiddenTests: 6, protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json"] },
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
	assert.equal(renderSubmission(rejectedView(), noHandles), [
		"Submitted job_7Q2K (attempt 1 of 3)",
		"Verifier result: REJECTED",
		"\tPR modifies frozen test file tests/totals.test.ts",
		"Job status: IN_PROGRESS",
		"Escrow: HELD, locked to devon-ops",
		"Attempts left: 2. Deadline: 2026-11-08 10:00 UTC.",
	].join("\n"));
});

test("the VERIFIED block matches docs/tutorial.md character for character", () => {
	assert.equal(renderSubmission(verifiedView(), noHandles), [
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

test("submit parses its flags, refuses unknown ones, and never prints a token", () => {
	const options = parseSubmitArgs(["job_7Q2K", "--dir", "/tmp/work", "--remote", "origin", "--timeout", "30"], { ACQUIT_TOKEN: "s3cret" });
	assert.deepEqual({ jobId: options.jobId, dir: options.dir, remote: options.remote, timeoutSeconds: options.timeoutSeconds,
		apiUrl: options.apiUrl, token: options.token }, { jobId: "job_7Q2K", dir: "/tmp/work", remote: "origin", timeoutSeconds: 30,
		apiUrl: "http://127.0.0.1:4310", token: "s3cret" });
	assert.throws(() => parseSubmitArgs(["--nope"], { ACQUIT_TOKEN: "s3cret" }), (error: CliError) => error.code === "USAGE");
	assert.throws(() => parseSubmitArgs(["job_7Q2K"], {}), (error: CliError) => error.code === "AUTH_REQUIRED" && !error.message.includes("s3cret"));
	assert.throws(() => parseSubmitArgs([], { ACQUIT_TOKEN: "s3cret" }), (error: CliError) => error.code === "USAGE");
});

test("localHead refuses a directory that is not a repository", () => {
	assert.throws(() => localHead("/tmp"), (error: CliError) => error.code === "NOT_A_REPOSITORY");
});

test("runSubmit polls until the submitted commit is judged and prints the block", async () => {
	const calls: string[] = [];
	let polls = 0;
	const client: ApiClient = { baseUrl: "http://api.test",
		async get(path) { calls.push(`GET ${path}`); polls++;
			return { job: polls === 1 ? rejectedView() : verifiedView(), handles: { "devon-ops": "devon-ops" } }; },
		async post(path, payload) { calls.push(`POST ${path} ${JSON.stringify(payload)}`); return { status: 200, body: { outcome: { kind: "COMMITTED" } } }; } };
	const printed = await runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted, push: () => { throw new Error("no push expected"); }, sleep: async () => {} });
	assert.match(printed, /Verifier result: VERIFIED/);
	assert.match(printed, /Pull request opened: maya-client\/invoice-app#13/);
	const payload = JSON.parse(calls[1].slice("POST /api/commands ".length)) as { key: string; command: unknown };
	assert.match(payload.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.deepEqual(payload.command, { type: "Submit", jobId: "job_7Q2K", sourceCommit: submitted });
	assert.equal(calls.filter(call => call.startsWith("GET /api/jobs/")).length, 2);
});

test("a denied submit names the operator the job is locked to", async () => {
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { return { job: rejectedView(), handles: { "devon-ops": "devon-ops" } }; },
		async post() { return { status: 409, body: { outcome: { kind: "DENIED", reason: "NOT_OWNER" } } }; } };
	await assert.rejects(() => runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 30, pollMs: 1 }, { client, head: () => submitted, push: () => {} }),
		(error: CliError) => error.code === "NOT_OWNER" && error.message.includes("locked to devon-ops"));
});

test("a run that never reports ends in a named timeout, not a hang", async () => {
	let now = 0;
	const view = rejectedView();
	const client: ApiClient = { baseUrl: "http://api.test",
		async get() { return { job: { ...view, attempts: { ...view.attempts, history: [],
			pending: { ordinal: 1, run: 1, runId: "run_job_7Q2K_1", sourceCommit: submitted, submittedAt: "2026-11-08T09:12:00.000Z",
				runEndsAt: "2026-11-08T09:42:00.000Z" } } }, handles: {} }; },
		async post() { return { status: 200, body: { outcome: { kind: "COMMITTED" } } }; } };
	await assert.rejects(() => runSubmit({ jobId: "job_7Q2K", dir: "/tmp/work", remote: null, apiUrl: "http://api.test", token: "s3cret",
		timeoutSeconds: 1, pollMs: 1 }, { client, head: () => submitted, push: () => {}, sleep: async () => { now += 2_000; }, now: () => now }),
		(error: CliError) => error.code === "VERIFIER_TIMEOUT" && error.message.includes("2026-11-08 09:42 UTC"));
});

test("the handle the block prints comes from the API, never from the id", () => {
	assert.equal(renderSubmission(rejectedView(), () => "devon-ops"), renderSubmission(rejectedView(), () => "devon-ops"));
	assert.match(renderSubmission(rejectedView(), () => "someone-else"), /Escrow: HELD, locked to someone-else/);
	assert.match(renderSubmission(rejectedView(), () => null), /Escrow: HELD, locked to devon-ops/);
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
		assert.equal(await main(["diff", "job_7Q2K"], {}), 2);
		assert.equal(await main(["submit", "job_7Q2K"], {}), 1);
		assert.match(errors.at(-1) ?? "", /^acquit: AUTH_REQUIRED: /);
		assert.equal(lines.some(line => line.includes("s3cret")), false);
	} finally { console.log = original.log; console.error = original.error; }
});
