import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { CommitSha, JobId, TestId } from "../src/ids.ts";
import { unconfiguredVerifier, VerifierCiNotConfigured } from "../src/verifier.ts";
import type { DefinitionOfDone, Verdict, VerifierRunId, VerifierRunRequest } from "../src/verifier.ts";
import { createLocalVerifier, createRemoteVerifier, parseCallbackBody, parseVerdict } from "../../verifier/ci.ts";
import { childProcessSubject } from "../../verifier/subject.ts";
import { gitSource, hiddenManifest } from "../../verifier/judge.ts";

const FIXTURE = [process.env.ACQUIT_VERIFIER_FIXTURE,
	fileURLToPath(new URL("../../../../../acquit/scratch/verifier/invoice-app", import.meta.url))]
	.find(candidate => candidate !== undefined && existsSync(join(candidate, ".git"))) ?? null;

const FROZEN_COMMIT = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const definition: DefinitionOfDone = { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
	frozenAt: FROZEN_COMMIT, frozenTests: Array.from({ length: 48 }, (_, index) => `frozen:${index + 1}` as TestId),
	hiddenManifest: hiddenManifest().digest, hiddenTests: hiddenManifest().cases.map(c => c.id),
	protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json"] as never };

const verifiedReport = { jobId: "job_ci_test", ordinal: 1, verdict: { result: "VERIFIED", runId: "run_ci_1", sourceCommit: FROZEN_COMMIT,
	mergeCommit: "5cccb66515313caed72e4af329a62fc011139426", pullRequest: 13, frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
	reportDigest: "a".repeat(64), at: instant("2026-10-06T12:00:00Z") } };

test("the unconfigured verifier refuses a start by name and never accepts a callback", async () => {
	const port = unconfiguredVerifier();
	await assert.rejects(() => port.start({} as VerifierRunRequest), (error: VerifierCiNotConfigured) => error.code === "VERIFIER_CI_NOT_CONFIGURED");
	assert.equal(await port.parseCallback(new Request("https://ci.test/callback", { method: "POST", body: "{}" })), null);
	const empty = createRemoteVerifier({ ciUrl: "  ", callbackSecret: "s3cret" });
	await assert.rejects(() => empty.start({} as VerifierRunRequest), (error: VerifierCiNotConfigured) => error.code === "VERIFIER_CI_NOT_CONFIGURED");
});

test("the callback boundary accepts only a signed report and drops every unsigned or malformed body", async () => {
	const port = createRemoteVerifier({ ciUrl: "https://ci.test", callbackSecret: "s3cret" });
	const signed = (body: string, secret = "s3cret") => new Request("https://ci.test/callback", { method: "POST",
		headers: { "x-acquit-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body });
	const raw = JSON.stringify(verifiedReport);
	assert.equal(await port.parseCallback(new Request("https://ci.test/callback", { method: "POST", body: raw })), null);
	assert.equal(await port.parseCallback(signed(raw, "wrong-secret")), null);
	assert.equal(await port.parseCallback(signed("{not json}")), null);
	assert.deepEqual(await port.parseCallback(signed(raw)), verifiedReport);
	assert.deepEqual(await port.parseCallback(signed(JSON.stringify({ ...verifiedReport, ordinal: 4 }))), null);
	assert.deepEqual(await port.parseCallback(signed(JSON.stringify({ ...verifiedReport, jobId: "not-a-job" }))), null);
	const tampered = { ...verifiedReport, verdict: { ...verifiedReport.verdict, reportDigest: undefined } };
	assert.deepEqual(await port.parseCallback(signed(JSON.stringify(tampered))), null);
});

test("parseVerdict refuses a verdict it cannot fully justify and keeps a rejection's named reason", () => {
	const rejected = { result: "REJECTED", runId: "run_ci_2", sourceCommit: FROZEN_COMMIT, at: "2026-10-06T12:00:00Z",
		reasons: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }, { kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1"] }] };
	assert.deepEqual(parseVerdict(rejected)?.result, "REJECTED");
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [] }), null);
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [{ kind: "SOMETHING_ELSE" }] }), null);
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [{ kind: "TREE_SYMLINK", path: "src/money.ts" }] })?.result, "REJECTED");
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [{ kind: "TREE_SYMLINK" }] }), null);
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [{ kind: "TREE_GITLINK", path: "src/money.ts" }] })?.result, "REJECTED");
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [{ kind: "TREE_GITLINK" }] }), null);
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [{ kind: "DIFF_TOO_LARGE", paths: 5000, limit: 4096 }] })?.result, "REJECTED");
	assert.deepEqual(parseVerdict({ ...rejected, reasons: [{ kind: "DIFF_TOO_LARGE", paths: 0, limit: 4096 }] }), null);
	assert.deepEqual(parseVerdict({ ...rejected, at: "yesterday" }), null);
	assert.deepEqual(parseVerdict({ ...verifiedReport.verdict, frozen: { expected: 48, passed: 49 } }), null);
	assert.deepEqual(parseVerdict({ ...verifiedReport.verdict, pullRequest: 0 }), null);
	assert.deepEqual(parseCallbackBody({ jobId: "job_ci_test", ordinal: 1, verdict: rejected })?.ordinal, 1);
});

test("the remote verifier posts the run and refuses a non-2xx answer", async () => {
	const calls: string[] = [];
	const port = createRemoteVerifier({ ciUrl: "https://ci.test", callbackSecret: "s3cret",
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(`${String(input)} ${String(init?.method)}`);
			return new Response("", { status: 202 }); }) as typeof fetch });
	await port.start({ runId: "run_ci_3" } as VerifierRunRequest);
	assert.deepEqual(calls, ["https://ci.test/runs POST"]);
	const refusing = createRemoteVerifier({ ciUrl: "https://ci.test", callbackSecret: "s3cret",
		fetch: (async () => new Response("nope", { status: 503 })) as typeof fetch });
	await assert.rejects(() => refusing.start({ runId: "run_ci_4" } as VerifierRunRequest), /HTTP 503/);
});

test("the local verifier runs the judge once per run id and hands the verdict to its listener", { skip: FIXTURE === null ? "Set ACQUIT_VERIFIER_FIXTURE to the invoice-app fixture." : false }, async () => {
	const seen: Verdict[] = [];
	const verifier = createLocalVerifier({ source: gitSource(FIXTURE!), subject: childProcessSubject(), publisher: createFakeGitHubApp(),
		clock: { now: () => instant("2026-10-06T12:00:00Z") }, onVerdict: async (_request, verdict) => { seen.push(verdict); } });
	const head = spawnSync("git", ["-C", FIXTURE!, "rev-parse", "fix-honest^{commit}"], { encoding: "utf8" }).stdout.trim() as CommitSha;
	const request: VerifierRunRequest = { runId: "run_ci_honest" as VerifierRunId, jobId: "job_ci_honest" as JobId, ordinal: 1,
		sourceCommit: head, definitionOfDone: definition };
	await verifier.start(request);
	await verifier.start(request);
	assert.equal(verifier.runs.size, 1);
	assert.equal(seen.length, 1);
	const outcome = verifier.runs.get("run_ci_honest" as VerifierRunId);
	assert.equal(outcome?.kind === "VERDICT" ? outcome.verdict.result : outcome?.kind, "VERIFIED");
	assert.equal(seen[0].result === "VERIFIED" ? seen[0].pullRequest : 0, 13);
});
