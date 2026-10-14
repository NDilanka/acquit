// AI scoping: the draft a model returns for one job's acceptance contract and hidden cases, the
// four filters it must pass (Prototype C's: runs on the frozen commit and fails there on an
// assertion mismatch; passes on a trusted fix; the expected value justified from the issue text;
// a person approves), the dedupe, and the per-currency-family coverage gate. The phases run
// through an injected port here; no Docker, no model, no network.

import assert from "node:assert/strict";
import test from "node:test";
import { coverageGate, parseScopeDraft, runScopeFilters } from "../src/scoping.ts";
import type { ScopeCandidate } from "../src/scoping.ts";
import type { CommitSha, TestId } from "../src/ids.ts";
import type { JsonValue } from "../src/verifier.ts";

const FROZEN = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const FIXED = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;

const ISSUE_BODY = [
	"Totals round wrong for 3-decimal currencies.",
	"The invoice total for a three-decimal currency such as BHD is rounded to two decimals,",
	"so a line of 1.235 renders 1.24 instead of 1.235. Zero-decimal currencies such as JPY",
	"must not gain a decimal place. Every total must carry the currency's own minor-unit count.",
].join("\n");

/** A draft with one candidate per behaviour the filters separate. */
function draftText(): string {
	return JSON.stringify({
		contract: "Every invoice total carries the currency's own minor-unit count; nothing rounds a three-decimal currency to two places.",
		candidates: [
			{ id: "cand:1", target: { module: "src/money.ts", export: "formatTotal" },
				args: [1235, "BHD"], expected: "1.235", citation: "a three-decimal currency such as BHD is rounded to two decimals" },
			{ id: "cand:2", target: { module: "src/money.ts", export: "formatTotal" },
				args: [123500, "JPY"], expected: "123500", citation: "Zero-decimal currencies such as JPY must not gain a decimal place" },
			{ id: "cand:3", target: { module: "src/money.ts", export: "formatTotal" },
				args: [100, "USD"], expected: "1.00", citation: "an invented citation that is nowhere in the issue" },
			{ id: "cand:4", target: { module: "src/money.ts", export: "formatTotal" },
				args: [999, "KWD"], expected: "0.999", citation: "the currency's own minor-unit count" },
		],
	});
}

/** A value nested deeper than the subject protocol's own bound. */
function deepValue(depth: number): JsonValue {
	let value: JsonValue = "x";
	for (let index = 0; index < depth; index += 1) value = [value];
	return value;
}

type PhaseReply = { readonly ok: boolean; readonly value: JsonValue | null; readonly error: string | null };

/** A phase runner the test scripts per commit: which candidates answer, with what. */
function phaseRunner(phases: { readonly frozen?: ReadonlyMap<string, PhaseReply>; readonly fixed?: ReadonlyMap<string, PhaseReply> }) {
	return async (commit: CommitSha, cases: readonly { readonly id: string }[]) => {
		const scripted = commit === FROZEN ? phases.frozen : commit === FIXED ? phases.fixed : undefined;
		if (!scripted) throw new Error(`the test scripted no ${commit === FROZEN ? "frozen" : "fixed"} phase`);
		const replies = new Map();
		for (const { id } of cases) {
			const reply = scripted.get(id);
			if (reply) replies.set(id, reply);
		}
		return replies as ReadonlyMap<TestId, PhaseReply>;
	};
}

test("the model's draft parses into a contract and candidates, each with a citation", () => {
	const draft = parseScopeDraft(draftText());
	assert.match(draft.contract, /minor-unit count/);
	assert.equal(draft.candidates.length, 4);
	assert.deepEqual(draft.candidates[0].target, { module: "src/money.ts", export: "formatTotal" });
	assert.equal(draft.candidates[0].args[1], "BHD");
	assert.match(draft.candidates[0].citation, /three-decimal currency/);
});

test("a malformed draft is refused by name: not JSON, an unknown field, a duplicate id, an unbounded value", () => {
	assert.throws(() => parseScopeDraft("not json at all"), /SCOPE_DRAFT_MALFORMED/);
	assert.throws(() => parseScopeDraft(JSON.stringify({ contract: "c", candidates: [{ id: "cand:1", target: { module: "m", export: "e" }, args: [], expected: null, citation: "c", sneaky: 1 }] })), /unknown field/);
	assert.throws(() => parseScopeDraft(JSON.stringify({ contract: "c", candidates: [
		{ id: "cand:1", target: { module: "m", export: "e" }, args: [], expected: null, citation: "c" },
		{ id: "cand:1", target: { module: "m", export: "e" }, args: [], expected: null, citation: "c" },
	] })), /duplicate/);
	assert.throws(() => parseScopeDraft(JSON.stringify({ contract: "c", candidates: [
		{ id: "cand:1", target: { module: "m", export: "e" }, args: [deepValue(40)], expected: null, citation: "c" },
	] })), /bounded/);
});

test("filters 1 and 2: a candidate that throws on the frozen commit is dropped; one the frozen code already satisfies is dropped; a discriminating one is kept", async () => {
	const draft = parseScopeDraft(draftText());
	const outcome = await runScopeFilters(draft, {
		issueBody: ISSUE_BODY, frozenAt: FROZEN, trustedFix: FIXED,
		runPhase: phaseRunner({
			frozen: new Map([
				// cand:1 throws on the frozen commit.
				["cand:1", { ok: false, value: null, error: "TypeError: undefined is not a function" }],
				// cand:2 runs but the frozen code already answers as expected — not discriminating.
				["cand:2", { ok: true, value: "123500", error: null }],
				// cand:3 and cand:4 run and mismatch — discriminating so far.
				["cand:3", { ok: true, value: "9.99", error: null }],
				["cand:4", { ok: true, value: "1.00", error: null }],
			]),
			fixed: new Map([
				["cand:3", { ok: false, value: null, error: "the module threw on the fix" }],
				["cand:4", { ok: true, value: "0.999", error: null }],
			]),
		}),
	});
	const byId = new Map(outcome.survivors.map(candidate => [candidate.id, candidate]));
	assert.equal(byId.has("cand:1"), false, "a candidate that throws on the frozen commit is dropped at filter 1");
	assert.equal(byId.has("cand:2"), false, "a candidate the frozen code already satisfies is dropped at filter 2");
	assert.ok(byId.has("cand:4"), "a discriminating candidate survives");
	assert.equal(outcome.counts.candidates, 4);
	assert.equal(outcome.counts.f1, 3, "candidates that ran without error on the frozen commit");
	assert.equal(outcome.counts.f2, 2, "of those, the ones the frozen reply mismatches");
});

test("filter 3: a candidate that errors or mismatches on the trusted fix is dropped; a matching one is kept", async () => {
	const draft = parseScopeDraft(draftText());
	const outcome = await runScopeFilters(draft, {
		issueBody: ISSUE_BODY, frozenAt: FROZEN, trustedFix: FIXED,
		runPhase: phaseRunner({
			frozen: new Map([
				["cand:2", { ok: true, value: "1.00", error: null }],
				["cand:4", { ok: true, value: "1.00", error: null }],
			]),
			fixed: new Map([
				// cand:2 errors even on the trusted fix — the case is wrong, not the code.
				["cand:2", { ok: false, value: null, error: "the module threw on the fix" }],
				// cand:4 passes on the trusted fix.
				["cand:4", { ok: true, value: "0.999", error: null }],
			]),
		}),
	});
	const byId = new Map(outcome.survivors.map(candidate => [candidate.id, candidate]));
	assert.equal(byId.has("cand:2"), false, "a candidate that errors on the trusted fix is dropped at filter 3");
	assert.ok(byId.has("cand:4"), "a candidate that passes on the trusted fix survives");
	assert.equal(outcome.counts.f3, 1);
});

test("filter 4: the expected value is justified from the issue text — a fabricated citation is dropped and a verbatim one kept, even when it appears only in the body", async () => {
	const draft = parseScopeDraft(draftText());
	const outcome = await runScopeFilters(draft, {
		issueBody: ISSUE_BODY, frozenAt: FROZEN, trustedFix: FIXED,
		runPhase: phaseRunner({
			frozen: new Map([
				["cand:3", { ok: true, value: "9.99", error: null }],
				["cand:4", { ok: true, value: "1.00", error: null }],
			]),
			fixed: new Map([
				["cand:3", { ok: true, value: "1.00", error: null }],
				["cand:4", { ok: true, value: "0.999", error: null }],
			]),
		}),
	});
	const byId = new Map(outcome.survivors.map(candidate => [candidate.id, candidate]));
	assert.equal(byId.has("cand:3"), false, "a fabricated citation is dropped at filter 4");
	assert.ok(byId.has("cand:4"), "a verbatim citation survives");
	const citation = byId.get("cand:4")?.citation ?? "";
	assert.ok(!ISSUE_TITLE.includes(citation), "the citation is not from the title");
	assert.ok(ISSUE_BODY.includes(citation), "the citation comes from the stored body");
	assert.equal(outcome.counts.f4, 1);
});

const ISSUE_TITLE = "#12 Totals round wrong";

test("dedupe collapses repeated candidates to one survivor per (target, args), and the counts report every filter", async () => {
	const text = JSON.stringify({
		contract: "c",
		candidates: [
			{ id: "cand:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "three-decimal currency such as BHD" },
			{ id: "cand:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "three-decimal currency such as BHD" },
			{ id: "cand:3", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "9.999", citation: "three-decimal currency such as BHD" },
		],
	});
	const outcome = await runScopeFilters(parseScopeDraft(text), {
		issueBody: ISSUE_BODY, frozenAt: FROZEN, trustedFix: FIXED,
		runPhase: phaseRunner({
			frozen: new Map([
				["cand:1", { ok: true, value: "1.24", error: null }],
				["cand:2", { ok: true, value: "1.24", error: null }],
				["cand:3", { ok: true, value: "1.24", error: null }],
			]),
			fixed: new Map([
				["cand:1", { ok: true, value: "1.235", error: null }],
				["cand:2", { ok: true, value: "1.235", error: null }],
				["cand:3", { ok: true, value: "9.999", error: null }],
			]),
		}),
	});
	assert.equal(outcome.counts.deduped, 1, "three candidates, same (target, args), collapse to one");
	assert.equal(outcome.survivors.length, 1);
	assert.deepEqual(outcome.survivors[0].expected, "1.235", "the first candidate in order is the one kept");
	assert.deepEqual(outcome.counts, { candidates: 3, f1: 3, f2: 3, f3: 3, f4: 3, deduped: 1 });
});

test("the coverage gate names every currency family the survivors do not cover", () => {
	const families = [
		{ name: "zero-decimal", currencies: ["JPY", "KRW"] },
		{ name: "three-decimal", currencies: ["BHD", "KWD", "TND"] },
	];
	const survivors: readonly ScopeCandidate[] = [
		{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [100, "USD"], expected: "1.00", citation: "c" },
	];
	const lacking = coverageGate(survivors, families);
	assert.equal(lacking.ok, false);
	if (!lacking.ok) assert.deepEqual(lacking.missing, ["zero-decimal", "three-decimal"], "each uncovered family is named");

	const covered: readonly ScopeCandidate[] = [
		{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500", citation: "c" },
		{ id: "draft:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "c" },
	];
	assert.deepEqual(coverageGate(covered, families), { ok: true });
});
