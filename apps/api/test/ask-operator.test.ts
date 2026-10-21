// The operator's ask as units: its four tools, the executor's refusals and ownership, the per-operator
// turn admission, and the contract and scope its turns run under. The HTTP side is ask-ledger-route.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCallLog } from "../../../packages/core/src/model.ts";
import { usd } from "../../../packages/core/src/acquit.ts";
import type { JobView } from "../../../packages/core/src/acquit.ts";
import { commercialSplit } from "../../../packages/core/src/ledger.ts";
import type { PayoutRowView } from "../src/payouts.ts";
import type { ReceiptRowView } from "../src/receipts.ts";
import {
	ASK_OPERATOR_TURN_CONTRACT, ASK_TOOL_NAMES, ASK_TURN_CONTRACT, OPERATOR_ASK_TOOL_NAMES, OPERATOR_TURNS_PER_DAY, OPERATOR_TURNS_PER_MINUTE,
	askLedgerTurn, askOperatorToolExecutor, askOperatorToolList, buildAskPrompt, operatorTurnLimiter,
} from "../src/ask.ts";

const question = [{ id: "m1", role: "user" as const, content: "What did I earn this week?" }];
const PLATFORM_AND_PAYPAL_NAMES = ["list_jobs", "get_job", "platform_totals", "get_order", "list_disputes", "get_dispute", "get_refund",
	"list_transactions", "trace_figure"];

/** A job the operator's OpenJobs read serves, held for `operatorId` at the bid it placed. Only the fields the escrow derivation and the executor read are set. */
const heldJob = (id: string, operatorId: string): JobView => ({
	id, title: `title of ${id}`, status: "IN_PROGRESS", phase: "BUILDING", escrow: "HELD", lockedTo: operatorId,
	bids: { operators: [{ operator: operatorId, price: usd("100.00") }], house: null },
} as unknown as JobView);

/** A settled job's receipt row, as operatorReceipts serves it: the payee operator and the cents. */
const receipt = (id: string, jobId: string, operatorId: string, paid: number, fee: number): ReceiptRowView => ({
	id, jobId, operator: operatorId, paid, fee, releasedAt: "2026-10-10T12:00:00.000Z", source: "JOB", passedVerifiedCi: true,
});

const payout = (jobId: string): PayoutRowView => ({
	jobId, payoutItemId: `item-${jobId}`, captureId: "CAP", paid: 9000, releasedAt: "2026-10-10T12:00:00.000Z",
	releaseAuthority: "CLIENT", repository: "acme/app",
});

/** One operator's executor, with its three reads counted, so a refused name can be shown to read nothing. */
function executorFor(operatorId: string, rows: { jobs: JobView[]; receipts: ReceiptRowView[]; payouts: PayoutRowView[] }) {
	const reads = { jobs: 0, receipts: 0, payouts: 0 };
	const execute = askOperatorToolExecutor({
		operatorId,
		jobs: async () => { reads.jobs += 1; return rows.jobs; },
		receipts: async () => { reads.receipts += 1; return rows.receipts; },
		payouts: async () => { reads.payouts += 1; return rows.payouts; },
	});
	return { execute, reads };
}

/** Two operators' rows in one book. Operator A's read is handed B's rows too, so the executor's own filters are what keep B out. */
const book = {
	jobs: [heldJob("job_a_held", "op-a"), heldJob("job_b_held", "op-b")],
	receipts: [receipt("rcpt_a", "job_a_paid", "op-a", 9000, 1000), receipt("rcpt_b", "job_b_paid", "op-b", 5000, 500)],
	payouts: [payout("job_a_paid"), payout("job_b_paid")],
};

test("the operator's tools are its four own-jobs reads, and none is a PayPal, book-wide, or trace tool", () => {
	const listed = askOperatorToolList().map(tool => tool.name);
	assert.deepEqual(listed, ["my_jobs", "my_job", "my_payouts", "my_totals"]);
	assert.deepEqual([...OPERATOR_ASK_TOOL_NAMES], listed, "the closed set the route checks is the list it serves");
	for (const name of listed) {
		assert.ok(!(ASK_TOOL_NAMES as readonly string[]).includes(name) && !PLATFORM_AND_PAYPAL_NAMES.includes(name), `${name} is a platform tool`);
	}
	for (const tool of askOperatorToolList()) {
		assert.doesNotMatch(tool.description, /all tenants|every operator|the whole book|across/i, `${tool.name} is worded for the whole book`);
	}
});

test("an operator's executor refuses a name outside its four, platform's or PayPal's alike, before any read", async () => {
	const { execute, reads } = executorFor("op-a", book);
	for (const name of ["list_jobs", "get_job", "list_transactions", "get_order", "platform_totals", "trace_figure", "capture_order", "delegate_to"]) {
		await assert.rejects(execute(name, {}), /no tool named/, `${name} is refused`);
	}
	assert.deepEqual(reads, { jobs: 0, receipts: 0, payouts: 0 }, "a refused name reads nothing");
});

test("my_job answers another operator's job id exactly as it answers an unknown id, and answers the operator's own job", async () => {
	const { execute } = executorFor("op-a", book);
	const own = await execute("my_job", { jobId: "job_a_held" }) as { jobId: string; escrow: string };
	assert.equal(own.jobId, "job_a_held");
	assert.equal(own.escrow, "HELD");
	const refusal = async (jobId: string): Promise<string> => {
		try { await execute("my_job", { jobId }); } catch (error) { return error instanceof Error ? error.message : String(error); }
		return "answered";
	};
	const unknown = (await refusal("job_nowhere")).replace("job_nowhere", "<id>");
	assert.notEqual(unknown, "answered");
	assert.equal((await refusal("job_b_held")).replace("job_b_held", "<id>"), unknown, "another operator's held job reads as unknown");
	assert.equal((await refusal("job_b_paid")).replace("job_b_paid", "<id>"), unknown, "another operator's settled job reads as unknown");
});

test("my_jobs, my_totals, and my_payouts for one operator never include another operator's job", async () => {
	const { execute } = executorFor("op-a", book);
	const jobs = await execute("my_jobs", {}) as { jobs: { jobId: string }[] };
	assert.deepEqual(jobs.jobs.map(job => job.jobId).sort(), ["job_a_held", "job_a_paid"]);
	const totals = await execute("my_totals", {}) as Record<string, number>;
	assert.deepEqual(totals, {
		paidOutCents: 9000, feesWithheldCents: 1000, jobsPaid: 1,
		heldCents: commercialSplit(usd("100.00")).operatorNet, heldJobs: 1,
	}, "the totals are the operator's own, summed as the earnings tiles sum them");
	const paid = await execute("my_payouts", {}) as { payouts: { jobId: string }[] };
	assert.deepEqual(paid.payouts.map(row => row.jobId), ["job_a_paid"]);
});

test("an operator's turns are admitted six a minute, the seventh in that minute is refused, and another operator is still admitted", () => {
	let at = 1_000_000;
	const admit = operatorTurnLimiter(() => at);
	for (let turn = 1; turn <= OPERATOR_TURNS_PER_MINUTE; turn += 1) {
		assert.equal(admit("op-a"), true, `turn ${turn} is inside the minute's allowance`);
	}
	assert.equal(admit("op-a"), false, "the turn past the minute's allowance is refused");
	assert.equal(admit("op-b"), true, "another operator's allowance is its own");
	at += 60_000;
	assert.equal(admit("op-a"), true, "a minute later the allowance has renewed");
});

test("an operator's turns are capped at sixty a day, and the cap renews a day after the first turn", () => {
	let at = 0;
	const admit = operatorTurnLimiter(() => at);
	for (let turn = 1; turn <= OPERATOR_TURNS_PER_DAY; turn += 1) {
		assert.equal(admit("op-a"), true, `turn ${turn} is inside the day's allowance`);
		at += 61_000;
	}
	assert.equal(admit("op-a"), false, "a turn past the day's allowance is refused");
	at = 24 * 60 * 60 * 1000 + 1;
	assert.equal(admit("op-a"), true, "a day after the first turn the allowance has renewed");
});

test("an operator's prompt carries the operator's contract and its own tools, and no platform tool or contract", () => {
	const prompt = buildAskPrompt({ messages: question, tools: askOperatorToolList(), contract: ASK_OPERATOR_TURN_CONTRACT });
	assert.ok(prompt.includes(ASK_OPERATOR_TURN_CONTRACT));
	assert.ok(!prompt.includes(ASK_TURN_CONTRACT));
	assert.match(prompt, /"name":"my_jobs"/);
	assert.doesNotMatch(prompt, /platform_totals|list_jobs/);
});

test("a turn with the operator scope is sent to the model under the operator's contract, with the operator's tools", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-ask-operator-"));
	try {
		const seen: string[] = [];
		const model = async (prompt: string) => {
			seen.push(prompt);
			return { ok: true as const, text: '{"message":"Nothing is held.","calls":[]}', sessionId: null, factoryCredits: 1 };
		};
		const outcome = await askLedgerTurn({ model, callLog: modelCallLog(join(root, "log.jsonl")) },
			{ messages: question, tools: askOperatorToolList(), scope: "OPERATOR" });
		assert.ok(outcome.ok);
		assert.equal(seen.length, 1);
		assert.ok(seen[0]?.includes(ASK_OPERATOR_TURN_CONTRACT), "the operator's contract is the one the model is shown");
		assert.doesNotMatch(seen[0] ?? "", /platform_totals/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
