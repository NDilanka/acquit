// Per-job manifests. OpenJob freezes one manifest per job from the deployment's fixture registry,
// keyed by fixture repository and issue; the judge later reads the job's own manifest, never a
// deployment-wide set. The registry may change after a job is open: the stored manifest holds.

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { executeCommand } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { CaptureId, ClientId, CommitSha, Digest, MerchantId, OrderId, OperatorId, TestId, Version } from "../src/ids.ts";
import type { JobRow } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { Bps, PayPal, ResourceRead } from "../src/paypal.ts";
import { parseWebhookEnvelope } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import { matchFixture, manifestOf, type FixtureContract } from "../src/fixtures.ts";
import { exampleCases, exampleContract, demoProtectedPaths } from "./hidden-fixture.ts";
import { bookEntry, fixtureBook } from "./verifier-book.ts";
import type { FixtureBookEntry } from "../../verifier/fixtures.ts";
import { splitterFixtureFrozenCases } from "../../verifier/frozen-cases.ts";
import { hiddenManifest } from "../../verifier/hidden.ts";
import { runJudge } from "../../verifier/judge.ts";
import type { SubjectLauncher } from "../../verifier/subject.ts";
import type { HiddenCase, SubjectCall, VerifierRunRequest } from "../src/verifier.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = instant("2026-10-06T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const requestKey = () => parseRequestKey(randomUUID());

/** Fixture 1: the demo fixture's shape, its hidden contract the test deployment's own. */
const fixtureA: FixtureContract = {
	repository: "maya-client/invoice-app",
	issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" },
	frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha,
	frozenTestPath: "tests/totals.test.ts",
	frozenTests: Array.from({ length: 48 }, (_, i) => `frozen:${i + 1}` as TestId),
	hiddenTests: exampleContract.ids,
	hiddenManifest: exampleContract.digest,
	protectedPaths: demoProtectedPaths,
	demoForkPrefix: "acquit-forks/",
};
/** Fixture 2's own private cases: three splitter cases, distinct ids from fixture 1's. */
const splitCases: readonly HiddenCase[] = [1, 2, 3].map(i => ({ id: `hidden2:${i}` as TestId,
	target: { module: "src/split.ts", export: "splitTotal" },
	args: [[{ amount: 10 * i }], "USD"], expected: `${5 * i}.00` }));
/** Fixture 2: a second fixture, its own issue, its own private cases (distinct ids and digest). */
const fixtureB: FixtureContract = {
	repository: "maya-client/expense-splitter",
	issue: { number: 7, title: "Split shares drop remainder cents" },
	frozenAt: "b4c7dad1e5a5a6b7c8d9e0f1a2b3c4d5e6f7a8b9" as CommitSha,
	frozenTestPath: "tests/split.test.ts",
	frozenTests: Array.from({ length: 12 }, (_, i) => `frozen:${i + 1}` as TestId),
	hiddenTests: splitCases.map(test => test.id),
	hiddenManifest: hiddenManifest(splitCases).digest,
	protectedPaths: ["tests/**"] as unknown as FixtureContract["protectedPaths"],
};

function emptyAccount(operator = "devon-ops" as OperatorId): import("../src/credits.ts").CreditAccount {
	return { operator, version: 0 as Version, balance: { allowance: 0 as import("../src/credits.ts").Credits, purchased: 0 as import("../src/credits.ts").Credits }, lines: [] };
}

function seedOperators(store: SqliteStore): void {
	for (const [handle, kind, agentName] of [
		["devon-ops", "INDEPENDENT", "ts-bugfixer"], ["house-tsfix", "HOUSE", "house-ts-fixer"],
	] as const) {
		const row: OperatorRow = { id: handle as OperatorId, handle, kind, version: 0 as Version,
			payouts: { kind: "READY", merchant, connectedAt: now } };
		const agent: Agent = { id: agentName as Agent["id"], owner: row.id, name: agentName,
			runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [] };
		store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), 0);
		store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(row.id, 0 as Version, JSON.stringify(emptyAccount(row.id)));
	}
}

/** Ports over one store and one fixture registry the test controls. */
function portsFor(store: SqliteStore, fixtures: readonly FixtureContract[]): Ports {
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const capture = {
		orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"),
		platformFee: usd("44.85"), sellerNet: usd("360.00"), capturedAt: now,
	};
	const paypal: PayPal = {
		dispatch: async () => ({ kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: capture.orderId, approveUrl: "https://example.test/approve" } }),
		reconcile: async () => ({ kind: "NOT_FOUND" }),
		getOrder: async () => ({ kind: "PENDING", checkAt: now }),
		parseWebhook: async raw => parseWebhookEnvelope(raw),
		verifyWebhookDelivery: async () => ({ kind: "VERIFIED" }),
		readResource: async () => ({ kind: "UNKNOWN" }) as ResourceRead,
	};
	return { store, feeModel: model, fixtures, clock: { now: () => now }, verifier: { start: unimplemented, parseCallback: unimplemented },
		github: { merge: unimplemented }, alerts: { raise: unimplemented }, paypal };
}

function fixtureRegistry(fixtures: readonly FixtureContract[]) {
	const store = new SqliteStore(":memory:", fixtures.map(f => ({ repository: f.repository, issue: { number: f.issue.number }, frozenTestPath: f.frozenTestPath, demoForkPrefix: f.demoForkPrefix })));
	seedOperators(store);
	return { store, ports: portsFor(store, fixtures) };
}

function jobOf(outcome: CommandOutcome) {
	assert.equal(outcome.kind, "COMMITTED");
	if (outcome.kind !== "COMMITTED" || outcome.result.kind !== "JOB") throw new Error("Expected a job result");
	return outcome.result.job.id;
}

const open = (repository: string, issueNumber: number): UserCommand =>
	({ type: "OpenJob", repository, issueNumber, budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z") });

test("OpenJob freezes one manifest per job from that job's own fixture", async () => {
	const { store, ports } = fixtureRegistry([fixtureA, fixtureB]);
	const jobA = jobOf(await executeCommand(ports, maya, requestKey(), open("maya-client/invoice-app", 12)));
	const jobB = jobOf(await executeCommand(ports, maya, requestKey(), open("maya-client/expense-splitter", 7)));

	const manifestA = await store.readManifest(jobA);
	const manifestB = await store.readManifest(jobB);
	assert.ok(manifestA && manifestB, "both jobs carry a manifest row");
	assert.deepEqual(manifestA, {
		issue: { repository: "maya-client/invoice-app", number: 12, title: "Totals round wrong for 3-decimal currencies" },
		frozenAt: fixtureA.frozenAt, frozenTestPath: "tests/totals.test.ts", frozenTests: fixtureA.frozenTests,
		hiddenTests: exampleContract.ids, hiddenManifest: exampleContract.digest, protectedPaths: [...fixtureA.protectedPaths],
	});
	assert.equal(manifestB.issue.repository, "maya-client/expense-splitter");
	assert.equal(manifestB.issue.number, 7);
	assert.equal(manifestB.frozenTestPath, "tests/split.test.ts");
	assert.deepEqual(manifestB.hiddenTests, ["hidden2:1", "hidden2:2", "hidden2:3"]);
	assert.equal(manifestB.hiddenManifest, fixtureB.hiddenManifest);
	// Exactly one manifest row per opened job, and the rows are distinct.
	const counted = store.db.prepare("SELECT COUNT(*) AS n FROM job_manifests").get() as { n: number };
	assert.equal(counted.n, 2);
	const rows = store.db.prepare("SELECT job_id, json FROM job_manifests ORDER BY job_id").all() as { job_id: string; json: string }[];
	assert.notEqual(rows[0].json, rows[1].json);
	assert.deepEqual(rows.map(row => row.job_id).sort(), [jobA, jobB].sort());
});

test("a stored manifest and contract do not move when the registry changes", async () => {
	const { store, ports } = fixtureRegistry([fixtureA, fixtureB]);
	const jobB = jobOf(await executeCommand(ports, maya, requestKey(), open("maya-client/expense-splitter", 7)));
	const frozen = await store.readManifest(jobB);
	const storedRow = await store.readJob(jobB);
	assert.ok(storedRow);

	// The deployment re-registers fixture 2 with a different digest and frozen commit; new jobs see it.
	const changed: FixtureContract[] = [fixtureA, { ...fixtureB, frozenAt: "cccccccccccccccccccccccccccccccccccccccc" as CommitSha, hiddenManifest: "ef".repeat(32) as Digest }];
	await executeCommand(portsFor(store, changed), maya, requestKey(), open("maya-client/expense-splitter", 7));

	assert.deepEqual(await store.readManifest(jobB), frozen, "the old job's manifest holds");
	assert.deepEqual(storedDefinitionOfDoneFor(storedRow), frozen, "the old job's contract holds");
	assert.equal((await store.listJobs()).length, 2);
});

/** The contract a stored row carries, through the same read boundary the production readers use. */
function storedDefinitionOfDoneFor(row: JobRow) {
	const done: unknown = row.contract.definitionOfDone;
	assert.ok(done, "the stored row carries a definition of done");
	return done;
}

test("an unregistered fixture is refused by name and writes nothing", async () => {
	const { store, ports } = fixtureRegistry([fixtureA, fixtureB]);
	const jobsBefore = (await store.listJobs()).length;
	const manifestsBefore = (store.db.prepare("SELECT COUNT(*) AS n FROM job_manifests").get() as { n: number }).n;

	const unknownRepo = await executeCommand(ports, maya, requestKey(), open("maya-client/other-repo", 12));
	assert.equal(unknownRepo.kind, "DENIED");
	assert.equal((unknownRepo as { reason: string }).reason, "NOT_FOUND");
	const unknownIssue = await executeCommand(ports, maya, requestKey(), open("maya-client/invoice-app", 13));
	assert.equal(unknownIssue.kind, "DENIED");
	assert.equal((unknownIssue as { reason: string }).reason, "NOT_FOUND");

	assert.equal((await store.listJobs()).length, jobsBefore);
	assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM job_manifests").get() as { n: number }).n, manifestsBefore);
});

test("a visitor opens on its own fork and the manifest names the fork; nobody else may", async () => {
	const { store, ports } = fixtureRegistry([fixtureA, fixtureB]);
	const fork = "acquit-forks/demo-aabbcc112233";
	const visitor: Actor = { role: "CLIENT", clientId: "guest-aabbcc112233-client" as ClientId, tenant: null, repository: fork };
	const job = jobOf(await executeCommand(ports, visitor, requestKey(), open(fork, 12)));
	const manifest = await store.readManifest(job);
	assert.ok(manifest);
	assert.equal(manifest.issue.repository, fork, "the manifest names the repository the job is on");
	assert.equal(manifest.frozenTestPath, fixtureA.frozenTestPath, "the fork inherits its fixture's frozen test path");

	// The same fork named by a session that does not own it is refused, and so is a seeded client on a fork.
	assert.equal((await executeCommand(ports, maya, requestKey(), open(fork, 12))).kind, "DENIED");
	const stranger: Actor = { role: "CLIENT", clientId: "guest-other-client" as ClientId, tenant: null, repository: "acquit-forks/demo-ffffffffffff" };
	assert.equal((await executeCommand(ports, stranger, requestKey(), open(fork, 12))).kind, "DENIED");
});

test("matchFixture keys on fixture repository and issue, with the demo fork rule", () => {
	const fixtures = [fixtureA, fixtureB];
	assert.equal(matchFixture(fixtures, "maya-client/invoice-app", 12, null)?.issue.title, fixtureA.issue.title);
	assert.equal(matchFixture(fixtures, "maya-client/expense-splitter", 7, null)?.repository, fixtureB.repository);
	assert.equal(matchFixture(fixtures, "maya-client/invoice-app", 7, null), null, "wrong issue for the repo");
	assert.equal(matchFixture(fixtures, "acquit-forks/demo-aabbcc112233", 12, "acquit-forks/demo-aabbcc112233")?.repository, fixtureA.repository);
	assert.equal(matchFixture(fixtures, "acquit-forks/demo-aabbcc112233", 12, null), null, "a fork name without a visitor actor");
	assert.equal(matchFixture(fixtures, "acquit-forks/other-aabbcc112233", 12, "acquit-forks/other-aabbcc112233"), null, "a fork outside the fixture's demo prefix");
});

test("two jobs on two fixtures in one verifier process: each run receives only its own cases", async () => {
	// Both fixture books load in one process; the run request's own manifest digest picks its case
	// set. The subject spy records the ids each run was handed: fixture A's 48 frozen and 6 hidden,
	// fixture B's 12 and 3, and never a case from the other fixture.
	const invoiceSource = Array.from({ length: 48 }, (_, i) =>
		`it('case ${i + 1}', () => { expect(formatTotal([{ amount: 1 }], 'KWD')).toBe('1'); });`).join("\n");
	const splitSource = Array.from({ length: 12 }, (_, i) =>
		`it('case ${i + 1}', () => { expect(splitTotal([{ amount: 2 }], 'KWD')).toBe('2'); });`).join("\n");
	const source = {
		readFile: (commit: CommitSha, path: string): string => {
			if (path === fixtureA.frozenTestPath) return invoiceSource;
			if (path === fixtureB.frozenTestPath) return splitSource;
			throw new Error(`unexpected read of ${path}`);
		},
		diff: () => ({ changes: [] }),
		materialize: () => ({ path: mkdtempSync(join(tmpdir(), "acquit-manifest-tree-")), link: null, remove: () => {} }),
	};
	const entryA = bookEntry(exampleCases);
	const entryB: FixtureBookEntry = { entry: { repository: fixtureB.repository, issue: { number: 7, title: fixtureB.issue.title },
		frozenAt: fixtureB.frozenAt, frozenTestPath: fixtureB.frozenTestPath, visible: 12, hidden: 3, hiddenIdPrefix: "hidden2",
		protectedPaths: ["tests/**"] as unknown as FixtureContract["protectedPaths"], hiddenCases: "(private)", frozenExtractor: "splitter-share" },
		cases: splitCases, digest: fixtureB.hiddenManifest, frozenCases: splitterFixtureFrozenCases };
	const fixtures = fixtureBook(entryA, entryB);
	const received: TestId[][] = [];
	const subject: SubjectLauncher = { variant: "CHILD_PROCESS", run: async (_tree, calls) => {
		received.push(calls.map(call => call.id));
		return { variant: "CHILD_PROCESS", nonce: "n".repeat(32), ready: true, stdout: "", stderr: "", exitCode: 0, signal: null, killedBy: null, faults: [], wallMs: 1 };
	} };
	const publisher = { publishVerified: async (): Promise<never> => { throw new Error("never publishes"); } } as never;

	const runA = await runJudge(
		{ runId: "run_a" as VerifierRunRequest["runId"], jobId: "job_a" as VerifierRunRequest["jobId"], ordinal: 1,
			sourceCommit: fixtureA.frozenAt, definitionOfDone: manifestOf(fixtureA, fixtureA.repository) },
		{ source, subject, publisher, fixtures });
	assert.equal(runA.kind, "VERDICT");
	const runB = await runJudge(
		{ runId: "run_b" as VerifierRunRequest["runId"], jobId: "job_b" as VerifierRunRequest["jobId"], ordinal: 1,
			sourceCommit: fixtureB.frozenAt, definitionOfDone: manifestOf(fixtureB, fixtureB.repository) },
		{ source, subject, publisher, fixtures });
	if (runB.kind !== "VERDICT") console.error("RUN B FAILURE:", JSON.stringify(runB.failure ?? runB));
	assert.equal(runB.kind, "VERDICT");
	assert.deepEqual(received[0], [...fixtureA.frozenTests, ...exampleContract.ids], "run A received fixture A's cases alone");
	assert.deepEqual(received[1], [...fixtureB.frozenTests, ...fixtureB.hiddenTests], "run B received fixture B's cases alone");
	// Each fixture names its own hidden id space; only the private hidden cases could ever cross.
	assert.notDeepEqual(received[0]!.slice(-6), received[1]!.slice(-3), "the two runs never share hidden cases");
});

test("a job whose manifest names ids its digest never digested refuses before anything runs", async () => {
	// Swapping the two jobs' manifests is refused by name: the digest picks the cases, and the ids
	// it carries must be the ones that digest digested. Nothing starts, so no case value is spent.
	const source = { readFile: (): string => { throw new Error("never read"); },
		diff: () => ({ changes: [] }), materialize: () => { throw new Error("never materializes"); } };
	const fixtures = fixtureBook(bookEntry(exampleCases));
	const swapped = { issue: { repository: fixtureB.repository, number: 7, title: fixtureB.issue.title },
		frozenAt: fixtureB.frozenAt, frozenTestPath: fixtureB.frozenTestPath, frozenTests: fixtureB.frozenTests,
		hiddenTests: fixtureB.hiddenTests, hiddenManifest: exampleContract.digest, protectedPaths: [...fixtureB.protectedPaths] };
	const outcome = await runJudge(
		{ runId: "run_swap" as VerifierRunRequest["runId"], jobId: "job_swap" as VerifierRunRequest["jobId"], ordinal: 1,
			sourceCommit: fixtureB.frozenAt, definitionOfDone: swapped },
		{ source, subject: { variant: "CHILD_PROCESS", run: async () => { throw new Error("the subject must not start"); } },
			publisher: { publishVerified: async (): Promise<never> => { throw new Error("never publishes"); } } as never, fixtures });
	assert.deepEqual(outcome.kind === "RUN_FAILED" ? outcome.failure : outcome.kind,
		{ name: "CONTRACT_MISMATCH", detail: "HIDDEN_CASES_MISMATCH" });
});
