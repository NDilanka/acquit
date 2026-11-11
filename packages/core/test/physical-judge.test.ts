// The physical judge end to end around a stub checker: each reply the checker can give, and each fault it can have, reaches
// its verdict by name. The sealed coordinates never appear in a verdict.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { runJudge } from "../../verifier/judge.ts";
import type { JudgeDeps, JudgeOutcome, PhysicalJudgeDeps } from "../../verifier/judge.ts";
import type { SubjectLauncher } from "../../verifier/subject.ts";
import type { PublisherPort } from "../src/github.ts";
import { instant, parseJobId } from "../src/ids.ts";
import type { CommitSha, Digest } from "../src/ids.ts";
import { verifierRunId } from "../src/job.ts";
import { LASER_CUT_WORKFLOW, LASER_PUBLIC_RULES, physicalDefinitionOf, parseSealedChecks } from "../src/physical.ts";
import type { SealedCheckSet } from "../src/physical.ts";
import type { Verdict, VerifierRunRequest } from "../src/verifier.ts";

const now = instant("2026-11-10T12:00:00Z");
const sourceCommit = "9d1c2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293" as CommitSha;
const jobId = parseJobId("job_physical_judge");
const digest = "3".repeat(64) as Digest;
const definitionOfDone = physicalDefinitionOf(LASER_CUT_WORKFLOW, "maya-client/invoice-app", digest);
const request: VerifierRunRequest = { runId: verifierRunId(jobId, 1), jobId, ordinal: 1, sourceCommit, definitionOfDone };

/** Three sealed checks: two kept points and one cut-away point. The coordinates are distinctive so a leak is visible. */
const sealed: SealedCheckSet = parseSealedChecks({ keepMaterialMm: [[7.25, 9.5], [11, 3]], voidMm: [[47.125, 20.75]] }) as SealedCheckSet;
const sealedCount = 3;

/**
 * A stub checker. The delivery text picks its reply, so each test drives one path. It reads its input the way the real
 * checker does: JSON on stdin, one JSON line on stdout.
 */
const dir = mkdtempSync(join(tmpdir(), "acquit-physical-judge-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const checkerEntry = join(dir, "checker.mjs");
writeFileSync(checkerEntry, `
const rules = ${JSON.stringify(LASER_PUBLIC_RULES)};
let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
const mode = input.artefact;
const reply = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (mode === "refuse") reply({ kind: "refused" });
else if (mode === "crash") process.exit(3);
else if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "malformed") reply({ kind: "checked", rules: { parse: true }, checks: [] });
else if (mode === "rejected-input") reply({ kind: "malformed" });
else if (mode === "fail-sealed") reply({ kind: "checked", rules: Object.fromEntries(rules.map(rule => [rule, true])), checks: input.checks.map((_, index) => index !== 0) });
else if (mode === "fail-rule") reply({ kind: "checked", rules: Object.fromEntries(rules.map(rule => [rule, rule !== "holes"])), checks: input.checks.map(() => true) });
else reply({ kind: "checked", rules: Object.fromEntries(rules.map(rule => [rule, true])), checks: input.checks.map(() => true) });
`);

/** The judge's dependencies: the delivery text is the artefact, and no tree or subject or publisher is ever touched. */
function depsFor(artefact: string | null, options: { sealed?: SealedCheckSet | null; entry?: string; deadlineMs?: number; physical?: boolean } = {}): JudgeDeps {
	const physical: PhysicalJudgeDeps | undefined = options.physical === false ? undefined : { sealedChecks: () => options.sealed === undefined ? sealed : options.sealed,
		checkerEntry: options.entry ?? checkerEntry, checkerDeadlineMs: options.deadlineMs };
	return {
		source: {
			diff: () => ({ changes: [] }),
			materialize: () => { throw new Error("a physical run never materializes a tree"); },
			readFile: () => { if (artefact === null) throw new Error("no such file"); return artefact; },
		},
		subject: { run: async () => { throw new Error("a physical run never starts a subject"); } } as unknown as SubjectLauncher,
		publisher: { publishVerified: async () => { throw new Error("a physical run publishes nothing"); } } as unknown as PublisherPort,
		fixtures: { source: "", byDigest: new Map() },
		clock: { now: () => now },
		physical,
	};
}

function verdictOf(outcome: JudgeOutcome): Verdict {
	assert.equal(outcome.kind, "VERDICT", JSON.stringify(outcome));
	if (outcome.kind !== "VERDICT") throw new Error("unreachable");
	return outcome.verdict;
}

test("a physical run with no physical deps fails the run by name, never a verdict", async () => {
	const outcome = await runJudge(request, depsFor("good", { physical: false }));
	assert.equal(outcome.kind, "RUN_FAILED");
	if (outcome.kind !== "RUN_FAILED") return;
	assert.deepEqual(outcome.failure, { name: "CONTRACT_MISMATCH", detail: "PHYSICAL_NOT_CONFIGURED" });
});

test("unreadable sealed checks fail the run, and nothing is judged", async () => {
	const outcome = await runJudge(request, depsFor("good", { sealed: null }));
	assert.equal(outcome.kind, "RUN_FAILED");
	if (outcome.kind !== "RUN_FAILED") return;
	assert.deepEqual(outcome.failure, { name: "CONTRACT_MISMATCH", detail: "SEALED_CHECKS_UNAVAILABLE" });
});

test("a missing delivery is rejected by its path", async () => {
	const verdict = verdictOf(await runJudge(request, depsFor(null)));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "DELIVERY_MISSING", path: "delivery/part.svg" }]);
	assert.equal(verdict.tallies, null);
});

test("a drawing the checker refuses at parse is rejected on the parse rule alone", async () => {
	const verdict = verdictOf(await runJudge(request, depsFor("refuse")));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "SPEC_RULES_FAILED", rules: ["parse"] }]);
});

test("a checker that crashes rejects the delivery with a fixed detail", async () => {
	const verdict = verdictOf(await runJudge(request, depsFor("crash")));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "CHECK_FAILED", detail: "CHECKER_CRASHED" }]);
});

test("a checker past its deadline is killed and the delivery is rejected, never left to stall", async () => {
	const started = Date.now();
	const verdict = verdictOf(await runJudge(request, depsFor("hang", { deadlineMs: 500 })));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "CHECK_FAILED", detail: "CHECKER_TIMEOUT" }]);
	assert.ok(Date.now() - started < 20_000, "the deadline must end the run promptly");
});

test("a malformed reply is a fault, never a pass", async () => {
	const verdict = verdictOf(await runJudge(request, depsFor("malformed")));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "CHECK_FAILED", detail: "CHECKER_REPLY_MALFORMED" }]);
});

test("a checker that reports its own input as malformed is a fault by name", async () => {
	const verdict = verdictOf(await runJudge(request, depsFor("rejected-input")));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "CHECK_FAILED", detail: "CHECKER_INPUT_REJECTED" }]);
});

test("an oversized delivery is refused before the checker runs", async () => {
	// The checker entry does not exist: if the judge ran it, the run would fault as a crash instead.
	const verdict = verdictOf(await runJudge(request, depsFor("x".repeat(1_000_001), { entry: join(dir, "missing.mjs") })));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "CHECK_FAILED", detail: "DELIVERY_TOO_LARGE" }]);
});

test("a clean drawing verifies with no pull request and every count passed", async () => {
	const verdict = verdictOf(await runJudge(request, depsFor("good")));
	assert.equal(verdict.result, "VERIFIED");
	if (verdict.result !== "VERIFIED") return;
	assert.equal(verdict.pullRequest, null);
	assert.equal(verdict.mergeCommit, sourceCommit);
	assert.deepEqual(verdict.frozen, { expected: LASER_PUBLIC_RULES.length, passed: LASER_PUBLIC_RULES.length });
	assert.deepEqual(verdict.hidden, { expected: sealedCount, passed: sealedCount });
});

test("a failed sealed check rejects with its count, and no sealed coordinate leaves the judge", async () => {
	const outcome = await runJudge(request, depsFor("fail-sealed"));
	const verdict = verdictOf(outcome);
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "SEALED_CHECKS_FAILED", failed: 1 }]);
	assert.deepEqual(verdict.tallies?.hidden, { expected: sealedCount, passed: sealedCount - 1 });
	const text = JSON.stringify(outcome);
	for (const coordinate of ["7.25", "9.5", "47.125", "20.75"]) assert.ok(!text.includes(coordinate), `a sealed coordinate ${coordinate} leaked`);
});

test("a failed public rule rejects by its rule name", async () => {
	const verdict = verdictOf(await runJudge(request, depsFor("fail-rule")));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "SPEC_RULES_FAILED", rules: ["holes"] }]);
});
