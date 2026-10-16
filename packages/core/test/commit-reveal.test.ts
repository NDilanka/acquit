// Commit, then reveal, for a job's per-job hidden cases: the seal at approval, the projection before
// close, the reveal after close through the store, and the fixture exclusion.

import assert from "node:assert/strict";
import test from "node:test";
import { projectJob, TERMS } from "../src/job.ts";
import type { JobRow, JobState, LockedBid, Receipt } from "../src/job.ts";
import { manifestOf } from "../src/fixtures.ts";
import { digestOfHiddenCases, perJobCaseOf, revealHiddenCases, sealHiddenCases } from "../src/hidden-seal.ts";
import type { PerJobHiddenCase, PrivateCaseReader } from "../src/hidden-seal.ts";
import { reduceLedger, usd } from "../src/ledger.ts";
import { hours, instant, parseJobId } from "../src/ids.ts";
import type { AgentId, BidId, CaptureId, ClientId, CommitSha, Digest, MerchantId, OperatorId, PayoutItemId, ReceiptId, TestId, Version } from "../src/ids.ts";
import type { Actor } from "../src/acquit.ts";
import { parseScopingFile } from "../src/scoping.ts";
import type { ScopeCandidate } from "../src/scoping.ts";
import { SqliteStore } from "../src/store.ts";
import { hiddenManifest } from "../../verifier/hidden.ts";
import { demoFixture, exampleCases } from "./hidden-fixture.ts";

const now = instant("2026-10-13T12:00:00Z");
const later = instant("2026-10-13T15:00:00Z");
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const merchant = "sandbox-seller" as MerchantId;
const jobId = "job_commit_reveal";

const drafted: readonly ScopeCandidate[] = [
	{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "three decimals" },
	{ id: "draft:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500", citation: "minor-unit count" },
];
const kept: readonly PerJobHiddenCase[] = drafted.map(perJobCaseOf);
const keptLiteral = [
	{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235" },
	{ id: "draft:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500" },
];

function contractWith(sealedHiddenCases: { readonly digest: Digest } | null) {
	const done = manifestOf(demoFixture(), "maya-client/invoice-app");
	return { budget: usd("400.00"), deliveryEndsAt: instant("2026-10-27T12:00:00Z"), terms: TERMS,
		definitionOfDone: sealedHiddenCases === null ? done
			: { ...done, hiddenTests: kept.map(test => test.id), hiddenManifest: hiddenManifest(kept).digest, sealedHiddenCases } };
}

function jobRow(state: JobState, contract: JobRow["contract"]): JobRow {
	return { id: parseJobId(jobId), version: 1 as Version, client: "maya-client" as ClientId, tenant: null, title: "per-job reveal",
		contract, openedAt: now, bids: [], state };
}

const openState: JobState = { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } };
const closedState: JobState = { status: "CLOSED", reason: "CLIENT_CANCEL", closedAt: later, book: [] };
const payee: LockedBid = { bidId: "bid_test-1" as BidId, operator: "devon-ops" as OperatorId, payee: merchant, agent: "ts-bugfixer" as AgentId, price: usd("360.00"), eta: hours(48) };

/** The private set a job's reader returns: the drafted candidates, citations included, and the salt that sealed them. */
const privateSetOf = (salt: string, candidates: readonly ScopeCandidate[] = drafted): PrivateCaseReader => () => ({ candidates, salt });

/** Captures what a call logs, so a refusal is asserted by its fixed text. */
function capturingLog<T>(run: () => T): { readonly value: T; readonly lines: readonly string[] } {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	try { return { value: run(), lines }; } finally { console.log = original; }
}

function refundedState(): JobState {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at: now });
	if ("kind" in held) throw new Error("law break");
	const refunded = reduceLedger(held, { kind: "Refund", refunded: usd("420.00"), at: later });
	if ("kind" in refunded) throw new Error("law break");
	return { status: "REFUNDED", payee, book: refunded, reason: "DELIVERY_DEADLINE",
		refund: { refundId: null, captureId: "TESTCAPTURE" as CaptureId, refunded: usd("420.00"), retainedProcessorFee: usd("15.15"), at: later },
		history: [], treasury: [] };
}

function paidState(): JobState {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at: now });
	if ("kind" in held) throw new Error("law break");
	const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at: later });
	if ("kind" in paid) throw new Error("law break");
	return { status: "PAID",
		payee,
		book: paid,
		receipt: { id: `rcpt_${jobId}` as ReceiptId, jobId: parseJobId(jobId), operator: "devon-ops" as OperatorId,
			agent: "ts-bugfixer" as AgentId, pullRequest: 13, mergeCommit: "5cccb66515313caed72e4af329a62fc011139426" as CommitSha,
			frozen: { expected: 48, passed: 48 }, hidden: { expected: 2, passed: 2 }, attemptsUsed: 2, paid: usd("360.00"), releasedAt: later } as Receipt,
		release: { payoutItemId: "payout-item-1" as PayoutItemId, captureId: "TESTCAPTURE" as CaptureId, paid: usd("360.00"), at: later },
		releaseAuthority: "CLIENT_APPROVAL", history: [], merge: { phase: "MERGED", at: later, sha: "d4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1" as CommitSha }, treasury: [] };
}

test("the digest of a case set is sha256 over the salt and the canonical cases, keys in code-unit order", () => {
	const literalCase = { id: "k:1" as TestId, target: { module: "m.ts", export: "f" }, args: [{ b: 1, B: 2 }], expected: "x" };
	// The canonical text is written by hand: `B` sorts ahead of `b` because UTF-16 code units put it first.
	assert.equal(digestOfHiddenCases([literalCase], "0".repeat(64)), "88ba671651396d9f474ebb7348a9d099d2ef276264f44ef44e70ae2f64e6a12f");
});

test("key order inside a case does not move the digest, and a different salt does", () => {
	const literalCase = { id: "k:1" as TestId, target: { module: "m.ts", export: "f" }, args: [{ b: 1, B: 2 }], expected: "x" };
	const reordered = { expected: "x", target: { export: "f", module: "m.ts" }, args: [{ B: 2, b: 1 }], id: "k:1" as TestId };
	assert.equal(digestOfHiddenCases([reordered], "0".repeat(64)), digestOfHiddenCases([literalCase], "0".repeat(64)));
	assert.notEqual(digestOfHiddenCases([literalCase], "1".repeat(64)), digestOfHiddenCases([literalCase], "0".repeat(64)));
	assert.throws(() => digestOfHiddenCases([literalCase], "ABC"), /32 bytes of lowercase hex/);
});

test("sealing draws a fresh 32-byte salt and seals the kept set under it", () => {
	const first = sealHiddenCases(kept);
	const second = sealHiddenCases(kept);
	assert.match(first.salt, /^[0-9a-f]{64}$/);
	assert.notEqual(first.salt, second.salt);
	assert.deepEqual(Object.keys(first.sealed), ["digest"]);
	assert.equal(first.sealed.digest, digestOfHiddenCases(kept, first.salt));
});

test("before close, the projection serves the sealed digest and nothing that opens it", () => {
	const seal = sealHiddenCases(kept);
	const job = projectJob(jobRow(openState, contractWith(seal.sealed)), maya, new Map(), undefined, undefined, privateSetOf(seal.salt));
	assert.deepEqual(job.contract?.sealedHiddenCases, { digest: seal.sealed.digest });
	assert.equal(job.hiddenReveal, null, "an open job reveals nothing, even with its private set on hand");
	const wire = JSON.stringify(job);
	assert.equal(wire.includes(seal.salt), false, "the salt never reaches an open job's projection");
	assert.equal(wire.includes("formatTotal"), false, "no case target reaches an open job's projection");
});

test("the freeze lands through the store, the open job shows the digest, and the closed job reveals the cases and the salt", async () => {
	const store = new SqliteStore(":memory:");
	try {
		const open = jobRow(openState, contractWith(null));
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(open.id, open.version, JSON.stringify(open), null);
		await store.writeScoping({ jobId: parseJobId(jobId), status: "AWAITING_APPROVAL", issueBody: "Totals round wrong",
			ids: [], digest: null, reason: null, counts: null, updatedAt: now });

		const seal = sealHiddenCases(kept);
		const manifest = { ...manifestOf(demoFixture(), "maya-client/invoice-app"), hiddenTests: kept.map(test => test.id),
			hiddenManifest: hiddenManifest(kept).digest, sealedHiddenCases: seal.sealed };
		const claimed = await store.claimApproval(parseJobId(jobId), { manifest, ids: kept.map(test => test.id),
			digest: hiddenManifest(kept).digest, counts: null, persist: () => {} }, now);
		assert.equal(claimed, "CLAIMED");

		const frozen = await store.readJob(parseJobId(jobId));
		assert.ok(frozen);
		assert.deepEqual(projectJob(frozen, maya, new Map()).contract?.sealedHiddenCases, { digest: seal.sealed.digest });

		const closed: JobRow = { ...frozen, version: 2 as Version, state: { status: "CLOSED", reason: "CLIENT_CANCEL", closedAt: later, book: [] } };
		store.db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify(closed), jobId);
		const after = await store.readJob(parseJobId(jobId));
		assert.ok(after);
		const job = projectJob(after, maya, new Map(), undefined, undefined, privateSetOf(seal.salt));
		assert.equal(job.status, "CLOSED");
		assert.deepEqual(job.hiddenReveal, { cases: keptLiteral, salt: seal.salt, digest: seal.sealed.digest });
		assert.equal(JSON.stringify(job.hiddenReveal).includes("three decimals"), false, "the citation is review prose and stays out of the reveal");
	} finally {
		store.db.close();
	}
});

test("revealHiddenCases refuses before close for every open status, and returns the literal set for every closed one", () => {
	const seal = sealHiddenCases(kept);
	for (const status of ["OPEN", "IN_PROGRESS", "VERIFIED"] as const) {
		assert.deepEqual(revealHiddenCases(status, seal.sealed, kept, seal.salt), { kind: "NOT_CLOSED" });
	}
	for (const status of ["PAID", "REFUNDED", "CLOSED"] as const) {
		assert.deepEqual(revealHiddenCases(status, seal.sealed, kept, seal.salt),
			{ kind: "REVEALED", value: { cases: keptLiteral, salt: seal.salt, digest: seal.sealed.digest } });
	}
});

test("every closed status serves the approved cases and the salt on the projection, and they recompute to the frozen digest", () => {
	const seal = sealHiddenCases(kept);
	const closedRows: readonly [JobState, string][] = [[paidState(), "PAID"], [refundedState(), "REFUNDED"], [closedState, "CLOSED"]];
	for (const [state, status] of closedRows) {
		const job = projectJob(jobRow(state, contractWith(seal.sealed)), devon, new Map(), undefined, undefined, privateSetOf(seal.salt));
		assert.equal(job.status, status);
		assert.deepEqual(job.hiddenReveal, { cases: keptLiteral, salt: seal.salt, digest: seal.sealed.digest }, `${status} reveals the approved cases`);
		assert.equal(digestOfHiddenCases(job.hiddenReveal!.cases, job.hiddenReveal!.salt), seal.sealed.digest);
	}
});

test("a fixture's curated set never reveals: the job is not sealed, and the type refuses its cases", () => {
	const paid = projectJob(jobRow(paidState(), contractWith(null)), devon, new Map(), undefined, undefined, privateSetOf("ab".repeat(32)));
	assert.equal(paid.contract && "sealedHiddenCases" in paid.contract, false, "an unsealed contract carries no seal field");
	assert.equal(paid.hiddenReveal, null, "an unsealed job reveals nothing, even when a private set is on hand");
	const salt = "ab".repeat(32);
	// @ts-expect-error a curated fixture case is a plain HiddenCase; only a PerJobHiddenCase reveals
	assert.deepEqual(revealHiddenCases("PAID", null, exampleCases, salt), { kind: "NOT_SEALED" });
});

test("a reveal whose cases or salt do not open the seal refuses by name", () => {
	const seal = sealHiddenCases(kept);
	const tampered = [perJobCaseOf({ ...drafted[0], expected: "9.999" }), kept[1]] as const;
	assert.deepEqual(revealHiddenCases("CLOSED", seal.sealed, tampered, seal.salt), { kind: "DIGEST_MISMATCH" });
	assert.deepEqual(revealHiddenCases("CLOSED", seal.sealed, kept, "cd".repeat(32)), { kind: "DIGEST_MISMATCH" });
});

test("a sealed closed job whose private cases do not open the seal reveals nothing and logs the refusal", () => {
	const seal = sealHiddenCases(kept);
	const tampered = drafted.map((candidate, index) => index === 0 ? { ...candidate, expected: "9.999" } : candidate);
	const { value, lines } = capturingLog(() => projectJob(jobRow(paidState(), contractWith(seal.sealed)), devon, new Map(), undefined, undefined, privateSetOf(seal.salt, tampered)));
	assert.equal(value.hiddenReveal, null);
	assert.equal(JSON.stringify(value).includes("9.999"), false, "the tampered case never reaches the projection");
	assert.deepEqual(lines, ["[reveal] job_commit_reveal: the private cases do not open the sealed digest; nothing revealed"]);
});

test("a sealed closed job whose private set is missing reveals nothing and logs the refusal", () => {
	const seal = sealHiddenCases(kept);
	const missing: PrivateCaseReader = () => null;
	const { value, lines } = capturingLog(() => projectJob(jobRow(paidState(), contractWith(seal.sealed)), devon, new Map(), undefined, undefined, missing));
	assert.equal(value.hiddenReveal, null);
	assert.deepEqual(lines, ["[reveal] job_commit_reveal: the private scoping file cannot be read; nothing revealed"]);
});

test("the private scoping file's salt must be 32 bytes of hex, and a valid one is kept", () => {
	const file = { version: 1, jobId, repository: "maya-client/invoice-app", issue: { number: 12, title: "Totals" },
		frozenAt: "a".repeat(40), contract: "Totals keep the currency's minor units.", approved: "2026-10-14T12:00:00.000Z", cases: [] };
	assert.throws(() => parseScopingFile(JSON.stringify({ ...file, salt: "not-hex" }), `${jobId}.json`), /salt must be 32 bytes of hex/);
	assert.equal(parseScopingFile(JSON.stringify({ ...file, salt: "ab".repeat(32) }), `${jobId}.json`).salt, "ab".repeat(32));
	assert.equal(parseScopingFile(JSON.stringify(file), `${jobId}.json`).salt, undefined);
});
