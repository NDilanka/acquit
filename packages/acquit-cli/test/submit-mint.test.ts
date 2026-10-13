// The scoped mint races the job work repository's async creation: a submit soon after funding can
// see the repository as not ready for a moment. The mint is retried briefly before any fallback,
// so the submission keeps the credential the API scoped to that repository alone.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliError } from "../src/client.ts";
import type { ApiClient } from "../src/client.ts";
import { runSubmit } from "../src/submit.ts";
import type { CommitSha } from "../../core/src/ids.ts";

const COMMIT = "e".repeat(40) as CommitSha;

type Post = { readonly path: string; readonly payload: Record<string, unknown> };

/** A client whose work-repo-token mint plays a scripted list of outcomes; every post is recorded. */
function mintClient(script: (() => unknown)[]): ApiClient & { readonly posts: Post[]; readonly sleeps: number[] } {
	const posts: Post[] = [];
	const sleeps: number[] = [];
	const view = {
		job: {
			id: "job_a2mint", status: "IN_PROGRESS", escrow: "HELD", lockedTo: "op_devon",
			reviewEndsAt: "2026-10-20T00:00:00.000Z",
			contract: { repository: "maya-client/invoice-app", frozenAt: "20261012.1" },
			attempts: { used: 1, left: 2, reasons: [], history: [{ ordinal: 1, result: "VERIFIED",
				sourceCommit: COMMIT, frozen: { passed: 48, expected: 48 }, hidden: { passed: 6, expected: 6 },
				pullRequest: 7, reasonsTruncated: 0 }], pending: null, failure: null },
		},
		handles: { op_devon: "devon-ops" },
		now: "2026-10-13T00:00:00.000Z",
	};
	return {
		baseUrl: "http://stub",
		get: async () => view,
		post: async (path: string, payload: unknown) => {
			posts.push({ path, payload: payload as Record<string, unknown> });
			if (path.endsWith("/work-repo-token")) {
				const next = script.shift();
				if (next) throw next();
				return { status: 200, body: { repository: "acquit-forks/invoice-app-a2x", token: "minted-token" } };
			}
			return { status: 200, body: { outcome: { kind: "COMMITTED" } } };
		},
		posts, sleeps,
	};
}

function mintDeps(client: ReturnType<typeof mintClient>, pushes: unknown[][]) {
	const secretPath = mkdtempSync(join(tmpdir(), "acquit-mint-secret-"));
	return {
		client,
		head: () => COMMIT,
		push: (...call: unknown[]) => pushes.push(call),
		makeSecretDir: () => ({ path: secretPath, remove: () => rmSync(secretPath, { recursive: true, force: true }) }),
		sleep: async (ms: number) => { client.sleeps.push(ms); },
		now: (() => { let tick = 0; return () => Date.parse("2026-10-13T00:00:00.000Z") + (tick++) * 1000; })(),
	};
}

test("a scoped mint that races the fork's creation is retried before anything falls back", async () => {
	const notReady = () => new CliError("WORK_REPO_NOT_READY", "The work repository is not visible.");
	const client = mintClient([notReady]);
	const pushes: unknown[][] = [];
	const verdict = await runSubmit({ jobId: "job_a2mint", dir: ".", remote: null, apiUrl: "http://stub",
		token: "session-token", timeoutSeconds: 1, pollMs: 1 }, mintDeps(client, pushes));
	assert.match(verdict, /VERIFIED/);
	const mints = client.posts.filter(post => post.path.endsWith("/work-repo-token"));
	assert.equal(mints.length, 2, "the mint is tried again after the not-ready answer");
	assert.deepEqual(client.sleeps, [1000], "the retry waits a short backoff");
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0]?.[1], "https://github.com/acquit-forks/invoice-app-a2x.git");
	const submits = client.posts.filter(post => post.path === "/api/commands");
	assert.equal(submits.length, 1);
	assert.equal((submits[0]?.payload.command as { sourceCommit?: string }).sourceCommit, COMMIT);
});

test("a mint that stays not ready still refuses the default target by name", async () => {
	const notReady = () => new CliError("WORK_REPO_NOT_READY", "The work repository is not visible.");
	const client = mintClient([notReady, notReady, notReady, notReady]);
	const pushes: unknown[][] = [];
	await assert.rejects(
		runSubmit({ jobId: "job_a2mint", dir: ".", remote: null, apiUrl: "http://stub",
			token: "session-token", timeoutSeconds: 1, pollMs: 1 }, mintDeps(client, pushes)),
		(error: CliError) => error.code === "WORK_REPO_NOT_READY",
	);
	assert.equal(client.posts.filter(post => post.path.endsWith("/work-repo-token")).length, 3, "two retries, then the refusal");
	assert.deepEqual(pushes, []);
	assert.equal(client.posts.some(post => post.path === "/api/commands"), false, "no Submit without a push");
});

test("a stranger's denial is never retried and is left to the Submit command", async () => {
	const notOwner = () => new CliError("NOT_OWNER", "Submit refused: the job is locked to another operator.");
	const client = mintClient([notOwner]);
	const pushes: unknown[][] = [];
	await runSubmit({ jobId: "job_a2mint", dir: ".", remote: null, apiUrl: "http://stub",
		token: "session-token", timeoutSeconds: 1, pollMs: 1 }, mintDeps(client, pushes));
	assert.equal(client.posts.filter(post => post.path.endsWith("/work-repo-token")).length, 1, "no retry on a stranger's denial");
	assert.deepEqual(pushes, []);
});
