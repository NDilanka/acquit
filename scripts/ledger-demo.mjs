import { performance } from "node:perf_hooks";
import { checkLaws, lawText, reduceLedger, usd } from "../packages/core/src/ledger.ts";

const started = performance.now();
const scenario = process.argv[2];
const at = "2026-11-03T15:22:00.000Z";
const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at });
if ("kind" in held) throw new Error("Hold refused");
const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at });
if ("kind" in paid || checkLaws(paid) !== "PAID") throw new Error("Tutorial release did not pay");

const refused = scenario === "double-release"
	? reduceLedger(paid, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at })
	: scenario === "release-then-refund"
		? reduceLedger(paid, { kind: "Refund", refunded: usd("420.00"), at })
		: null;
if (!refused || !("kind" in refused)) {
	console.error("Use double-release or release-then-refund.");
	process.exit(2);
}
const elapsed = performance.now() - started;
console.log(`REJECTED  ${lawText(refused.law)}`);
if (elapsed >= 20_000) {
	console.error(`elapsed ${elapsed.toFixed(0)} ms`);
	process.exit(1);
}
