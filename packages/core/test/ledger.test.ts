import assert from "node:assert/strict";
import test from "node:test";
import { commercialSplit, formatUsd, reduceLedger, releaseTreasury, refundTreasury, usd } from "../src/ledger.ts";
import { instant, parseJobId } from "../src/ids.ts";
import type { OperatorId } from "../src/ids.ts";

const at = instant("2026-11-03T15:22:00Z");
const jobId = parseJobId("job_7Q2K");
const devon = "devon-ops" as OperatorId;

test("tutorial release records HELD 42000, RELEASED 36000, and FEE 6000", () => {
	const split = commercialSplit(usd("400.00"));
	const held = reduceLedger([], { kind: "Hold", gross: split.held, at });
	assert.equal("kind" in held, false);
	if ("kind" in held) return;
	const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at });
	assert.deepEqual(paid, [
		{ kind: "HELD", cents: 42000, at },
		{ kind: "RELEASED", cents: 36000, at },
		{ kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at },
	]);
	assert.equal(formatUsd(36000 as never), "360.00");
});

test("card funding records the observed 363.78 net and the processor variance", () => {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at });
	if ("kind" in held) throw new Error("Hold refused");
	const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("363.78"), processorFee: usd("11.37"), platformFee: usd("44.85"), at });
	assert.deepEqual(paid, [
		{ kind: "HELD", cents: 42000, at },
		{ kind: "RELEASED", cents: 36378, at },
		{ kind: "FEE", cents: 5622, processor: 1137, acquit: 4485, at },
	]);
	assert.deepEqual(releaseTreasury({ jobId, operator: devon, promisedNet: usd("360.00"), observedNet: usd("363.78"), predictedProcessorFee: usd("15.15"), observedProcessorFee: usd("11.37"), at }), [
		{ kind: "PROCESSOR_FEE_VARIANCE", jobId, predicted: 1515, observed: 1137, at },
	]);
});

test("a higher observed fee records the variance and the operator shortfall", () => {
	assert.deepEqual(releaseTreasury({ jobId, operator: devon, promisedNet: usd("360.00"), observedNet: usd("359.00"), predictedProcessorFee: usd("15.15"), observedProcessorFee: usd("16.15"), at }), [
		{ kind: "PROCESSOR_FEE_VARIANCE", jobId, predicted: 1515, observed: 1615, at },
		{ kind: "OPERATOR_REIMBURSEMENT_OWED", jobId, operator: devon, cents: 100, cause: "NET_BELOW_PROMISE", at },
	]);
	assert.deepEqual(releaseTreasury({ jobId, operator: devon, promisedNet: usd("360.00"), observedNet: usd("360.00"), predictedProcessorFee: usd("15.15"), observedProcessorFee: usd("15.15"), at }), []);
});

test("a net below the promise is owed back even when the fee matched the quote", () => {
	assert.deepEqual(releaseTreasury({ jobId, operator: devon, promisedNet: usd("360.00"), observedNet: usd("358.00"), predictedProcessorFee: usd("15.15"), observedProcessorFee: usd("15.15"), at }), [
		{ kind: "OPERATOR_REIMBURSEMENT_OWED", jobId, operator: devon, cents: 200, cause: "NET_BELOW_PROMISE", at },
	]);
	assert.deepEqual(releaseTreasury({ jobId, operator: devon, promisedNet: usd("360.00"), observedNet: usd("360.50"), predictedProcessorFee: usd("15.15"), observedProcessorFee: usd("15.15"), at }), []);
});

test("a full refund equals HELD and records the fee PayPal kept", () => {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at });
	if ("kind" in held) throw new Error("Hold refused");
	assert.deepEqual(reduceLedger(held, { kind: "Refund", refunded: usd("420.00"), at }), [
		{ kind: "HELD", cents: 42000, at },
		{ kind: "REFUND", cents: 42000, at },
	]);
	assert.deepEqual(refundTreasury({ jobId, operator: devon, retainedProcessorFee: usd("15.15"), at }), [
		{ kind: "REFUND_FEE_RETAINED", jobId, cents: 1515, at },
		{ kind: "OPERATOR_REIMBURSEMENT_OWED", jobId, operator: devon, cents: 1515, cause: "REFUND_DEBITED_OPERATOR", at },
	]);
});

test("a release that does not add up to HELD is refused", () => {
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at });
	if ("kind" in held) throw new Error("Hold refused");
	assert.deepEqual(reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.00"), at }),
		{ kind: "LAW_BREAK", law: "conservation" });
	assert.deepEqual(reduceLedger(held, { kind: "Refund", refunded: usd("400.00"), at }), { kind: "LAW_BREAK", law: "conservation" });
});
