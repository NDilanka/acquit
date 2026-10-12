// `acquit confirm-submit`: the operator's half of the MCP server's submit confirmation. The answer
// is typed at the prompt; no flag and no file the model can write stands in for it. The rendezvous
// files the command shares with the waiting submit_attempt call carry a job id and a commit, and
// nothing secret.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliError } from "../src/client.ts";
import { parseConfirmArgs, runConfirmSubmit } from "../src/confirm.ts";
import { claimConfirmation, readRequest, writeRequest } from "../src/rendezvous.ts";
import type { CommitSha } from "../../core/src/ids.ts";

const COMMIT = "a".repeat(40) as CommitSha;
const OTHER = "b".repeat(40) as CommitSha;

const dir = () => mkdtempSync(join(tmpdir(), "acquit-confirm-"));

test("confirm-submit refuses a flag where the operator's typed answer belongs", () => {
	for (const argv of [["--yes"], ["--force"], ["job_a2", "--confirm"], ["--commit", COMMIT], ["job_a2", "extra"]]) {
		assert.throws(() => parseConfirmArgs(argv, {}), (error: CliError) => error.code === "USAGE");
	}
	assert.equal(parseConfirmArgs(["job_a2"], {}).jobId, "job_a2");
});

test("with no pending request there is nothing to confirm", async () => {
	const confirmDir = dir();
	await assert.rejects(
		runConfirmSubmit({ jobId: "job_a2", confirmDir }, { ask: async () => "y", write: () => {} }),
		(error: CliError) => error.code === "NO_REQUEST",
	);
	assert.equal(existsSync(join(confirmDir, "job_a2.confirmation.json")), false);
});

test("a typed yes writes a 0600 confirmation naming the full commit, claimable exactly once", async () => {
	const confirmDir = dir();
	writeRequest(confirmDir, { jobId: "job_a2", commit: COMMIT, requestedAt: "2026-10-13T00:00:00.000Z" });
	const written: string[] = [];
	const exit = await runConfirmSubmit({ jobId: "job_a2", confirmDir },
		{ ask: async () => "y", write: line => written.push(line), now: () => Date.parse("2026-10-13T00:00:01.000Z") });
	assert.equal(exit, 0);
	const path = join(confirmDir, "job_a2.confirmation.json");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	// The prompt shows the whole SHA, so the operator confirms a commit they can read in full.
	assert(written.join("").includes(COMMIT), "the prompt must show the full 40-character commit");
	const claimed = claimConfirmation(confirmDir, "job_a2");
	assert.equal(claimed?.commit, COMMIT);
	assert.equal(claimConfirmation(confirmDir, "job_a2"), null, "a confirmation claims exactly once");
});

test("a typed no, and a refused prompt, leave nothing to claim", async () => {
	const confirmDir = dir();
	writeRequest(confirmDir, { jobId: "job_a2", commit: COMMIT, requestedAt: "2026-10-13T00:00:00.000Z" });
	const exit = await runConfirmSubmit({ jobId: "job_a2", confirmDir }, { ask: async () => "no", write: () => {} });
	assert.equal(exit, 1);
	assert.equal(claimConfirmation(confirmDir, "job_a2"), null);
	await assert.rejects(
		runConfirmSubmit({ jobId: "job_a2", confirmDir }, { ask: async () => { throw new Error("prompt refused"); }, write: () => {} }),
	);
	assert.equal(claimConfirmation(confirmDir, "job_a2"), null);
});

test("a fresh request drops a stale confirmation for an older commit", async () => {
	const confirmDir = dir();
	writeRequest(confirmDir, { jobId: "job_a2", commit: COMMIT, requestedAt: "2026-10-13T00:00:00.000Z" });
	await runConfirmSubmit({ jobId: "job_a2", confirmDir }, { ask: async () => "y", write: () => {} });
	// The checkout's HEAD moved: the next submit_attempt rewrites the request, and the older
	// confirmation for the older commit can never speak for it.
	writeRequest(confirmDir, { jobId: "job_a2", commit: OTHER, requestedAt: "2026-10-13T00:01:00.000Z" });
	assert.equal(claimConfirmation(confirmDir, "job_a2"), null);
	assert.equal(readRequest(confirmDir, "job_a2")?.commit, OTHER);
});

test("a malformed confirmation refuses by name and leaves no claimed file behind", () => {
	const confirmDir = dir();
	writeRequest(confirmDir, { jobId: "job_a2", commit: COMMIT, requestedAt: "2026-10-13T00:00:00.000Z" });
	writeFileSync(join(confirmDir, "job_a2.confirmation.json"), "not json", { mode: 0o600 });
	assert.throws(() => claimConfirmation(confirmDir, "job_a2"), /malformed/);
	assert.equal(existsSync(join(confirmDir, "job_a2.confirmation.json.claimed")), false);
	assert.equal(readRequest(confirmDir, "job_a2")?.commit, COMMIT, "the request stays alive for the operator");
});
