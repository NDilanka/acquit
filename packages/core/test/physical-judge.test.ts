// The physical judge end to end around a stub checker: each reply the checker can give, and each fault it can have, reaches
// its verdict by name. The sealed coordinates never appear in a verdict.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { gitSource, runJudge } from "../../verifier/judge.ts";
import type { JudgeDeps, JudgeOutcome, JudgeSource, PhysicalJudgeDeps } from "../../verifier/judge.ts";
import { createVerifierService, parseRunRequest } from "../../verifier/service.ts";
import type { VerifierService } from "../../verifier/service.ts";
import { RUN_NONCE_HEADER, RUN_SIGNATURE_HEADER, RUN_TIMESTAMP_HEADER, runSignature } from "../../verifier/signing.ts";
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

const boundarySecret = "run-secret-for-the-physical-boundary";

/** A run request signed the way the API signs one: the same headers over the same bytes the service reads. */
function signedRun(body: string): Request {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = randomBytes(16).toString("hex");
	return new Request("http://verifier.test/runs", { method: "POST", headers: { "content-type": "application/json",
		[RUN_TIMESTAMP_HEADER]: timestamp, [RUN_NONCE_HEADER]: nonce, [RUN_SIGNATURE_HEADER]: `sha256=${runSignature(boundarySecret, timestamp, nonce, body)}` }, body });
}

/** The verifier service with its physical judge wired to the stub checker, and a source that serves one artefact. */
function physicalService(artefact: string): VerifierService {
	const source: JudgeSource = { diff: () => ({ changes: [] }), materialize: () => { throw new Error("a physical run never materializes a tree"); },
		readFile: () => artefact };
	return createVerifierService({ runSecret: boundarySecret, fixtures: { source: "", byDigest: new Map() },
		callback: { url: "http://127.0.0.1:1/callback", secret: "callback-secret-for-the-physical-boundary" },
		subject: { run: async () => { throw new Error("a physical run never starts a subject"); } } as unknown as SubjectLauncher,
		publisher: { publishVerified: async () => { throw new Error("a physical run publishes nothing"); } } as unknown as PublisherPort,
		source: async () => ({ source, remove: () => {} }), physical: { sealedChecks: () => sealed, checkerEntry, checkerDeadlineMs: undefined }, log: () => {} });
}

test("a physical definition crosses the signed run boundary and is judged, and a code definition with no test path is still refused", async () => {
	const service = physicalService("good");
	const body = JSON.stringify({ runId: request.runId, jobId, ordinal: 1, sourceCommit, definitionOfDone });
	// The parser takes exactly what physicalDefinitionOf() emits: an empty frozen path and empty test lists.
	const accepted = await service.handle(signedRun(body));
	assert.equal(accepted.status, 202, await accepted.clone().text());
	assert.equal(((await accepted.json()) as { accepted: boolean }).accepted, true);
	await service.whenIdle();
	const record = service.runs.get(request.runId)!;
	assert.equal(record.refusal, null);
	const outcome = record.outcome;
	assert.equal(outcome?.kind, "VERDICT");
	if (outcome?.kind !== "VERDICT") return;
	assert.equal(outcome.verdict.result, "VERIFIED");

	const codeBody = JSON.stringify({ runId: "run_physical_code_refused", jobId, ordinal: 1, sourceCommit,
		definitionOfDone: { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals" }, frozenAt: LASER_CUT_WORKFLOW.frozenAt,
			frozenTestPath: "", frozenTests: [], hiddenTests: [], hiddenManifest: digest, protectedPaths: [] } });
	const pathed = JSON.stringify({ runId: "run_physical_path_refused", jobId, ordinal: 1, sourceCommit,
		definitionOfDone: { ...definitionOfDone, frozenTestPath: "tests/totals.test.ts" } });
	const listed = JSON.stringify({ runId: "run_physical_list_refused", jobId, ordinal: 1, sourceCommit,
		definitionOfDone: { ...definitionOfDone, frozenTests: ["frozen:1"] } });
	for (const refused of [codeBody, pathed, listed]) {
		const answer = await service.handle(signedRun(refused));
		assert.equal(answer.status, 400);
		assert.deepEqual(await answer.json(), { error: "RUN_BODY_INVALID" });
	}
	assert.equal(service.runs.size, 1);
	await service.close();
});

test("a code run ignores physical metadata this service cannot read, as main ignored unknown keys", () => {
	const codeDefinition = { issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals" }, frozenAt: LASER_CUT_WORKFLOW.frozenAt,
		frozenTestPath: "tests/totals.test.ts", frozenTests: [], hiddenTests: [], hiddenManifest: digest, protectedPaths: [] };
	for (const physical of [{ workflow: "pcb", deliveryPath: "delivery/board.gbr", publicSpec: {}, specDigest: digest }, "laser-cut", null]) {
		const parsed = parseRunRequest(JSON.parse(JSON.stringify({ runId: request.runId, jobId, ordinal: 1, sourceCommit,
			definitionOfDone: { ...codeDefinition, physical } })));
		assert.notEqual(parsed, null, `physical ${JSON.stringify(physical)} must not fail a code run`);
		assert.equal(parsed?.definitionOfDone.physical, undefined);
		assert.equal(parsed?.definitionOfDone.frozenTestPath, "tests/totals.test.ts");
	}
	// A physical definition freezes no test, so its path is empty and its physical block must still read.
	const unreadable = parseRunRequest(JSON.parse(JSON.stringify({ runId: request.runId, jobId, ordinal: 1, sourceCommit,
		definitionOfDone: { ...definitionOfDone, physical: "laser-cut" } })));
	assert.equal(unreadable, null);
});

/** Runs git in a repository and returns its trimmed output. */
function gitIn(repo: string, args: readonly string[], input?: string): string {
	const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", input });
	if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
	return result.stdout.trim();
}

/**
 * A two-commit repository whose submitted commit holds what `entry` stages at delivery/part.svg. A link is staged from
 * its index entry, so nothing is written to disk for it, and the judge reads the tree entry a push would deliver.
 */
function deliveryRepository(entry: (repo: string) => void): { readonly repo: string; readonly head: CommitSha; readonly remove: () => void } {
	const repo = mkdtempSync(join(tmpdir(), "acquit-physical-tree-"));
	gitIn(repo, ["init", "-q"]);
	gitIn(repo, ["config", "user.email", "fixture@example.invalid"]);
	gitIn(repo, ["config", "user.name", "fixture"]);
	writeFileSync(join(repo, "README.md"), "fixture\n");
	gitIn(repo, ["add", "-A"]);
	gitIn(repo, ["commit", "-qm", "frozen"]);
	entry(repo);
	gitIn(repo, ["commit", "-qm", "submitted"]);
	return { repo, head: gitIn(repo, ["rev-parse", "HEAD"]) as CommitSha, remove: () => rmSync(repo, { recursive: true, force: true }) };
}

/** Judges a physical run whose delivery is the tree entry `entry` stages, read through the real git source. */
async function judgedDelivery(entry: (repo: string) => void): Promise<Verdict> {
	const delivery = deliveryRepository(entry);
	try {
		return verdictOf(await runJudge({ ...request, sourceCommit: delivery.head }, { ...depsFor("good"), source: gitSource(delivery.repo) }));
	} finally { delivery.remove(); }
}

test("a physical delivery that is a symlink is refused by name, and its target text is never judged", async () => {
	// The link's target text is a path, and the stub checker would pass any text it is given, so a read of the link fails the test.
	const verdict = await judgedDelivery(repo => {
		const target = gitIn(repo, ["hash-object", "-w", "--stdin"], "delivery/real.svg");
		gitIn(repo, ["update-index", "--add", "--cacheinfo", `120000,${target},delivery/part.svg`]);
	});
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "DELIVERY_MISSING", path: "delivery/part.svg" }]);
});

test("a physical delivery that is a submodule is refused by name", async () => {
	const verdict = await judgedDelivery(repo => gitIn(repo, ["update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},delivery/part.svg`]));
	assert.equal(verdict.result, "REJECTED");
	if (verdict.result !== "REJECTED") return;
	assert.deepEqual(verdict.reasons, [{ kind: "DELIVERY_MISSING", path: "delivery/part.svg" }]);
});

test("a physical delivery that is a regular file is judged through the git source", async () => {
	const verdict = await judgedDelivery(repo => {
		mkdirSync(join(repo, "delivery"));
		writeFileSync(join(repo, "delivery", "part.svg"), "good");
		gitIn(repo, ["add", "-A"]);
	});
	assert.equal(verdict.result, "VERIFIED");
});

test("a code read of a symlink returns the link's target text, as git shows it, and only a physical read refuses it", () => {
	const delivery = deliveryRepository(repo => {
		const target = gitIn(repo, ["hash-object", "-w", "--stdin"], "tests/real.test.ts");
		gitIn(repo, ["update-index", "--add", "--cacheinfo", `120000,${target},tests/link.test.ts`]);
	});
	try {
		const source = gitSource(delivery.repo);
		assert.equal(source.readFile(delivery.head, "tests/link.test.ts"), "tests/real.test.ts");
		assert.throws(() => source.readFile(delivery.head, "tests/link.test.ts", "regular"), /is not a regular file/);
	} finally { delivery.remove(); }
});
