import assert from "node:assert/strict";
import test from "node:test";
import { applyLedgerMove, checkLaws, reduceLedger, usd } from "../src/ledger.ts";
import type { EscrowBook, LedgerLaw, LedgerMove } from "../src/ledger.ts";
import { instant } from "../src/ids.ts";

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function bookState(book: EscrowBook): "OPEN" | "PAID" | "REFUNDED" {
	const lines = [...book];
	if (lines.length === 3) return "PAID";
	if (lines.length === 2) return "REFUNDED";
	return "OPEN";
}
function cents(rand: () => number, max: number): number {
	return Math.floor(rand() * (max + 1));
}

function move(rand: () => number, held: number): LedgerMove {
	const at = instant("2026-11-03T15:22:00Z");
	const roll = rand();
	if (roll < 0.34) return { kind: "Hold", gross: usd(String(1 + cents(rand, 100000))), at };
	if (roll < 0.67) {
		const operatorNet = cents(rand, held + 1000);
		const processorFee = cents(rand, held + 1000);
		return { kind: "Release", operatorNet: operatorNet as never, processorFee: processorFee as never, platformFee: Math.max(0, held - operatorNet - processorFee) as never, at };
	}
	return { kind: "Refund", refunded: (rand() < 0.5 ? held : cents(rand, held + 1000)) as never, at };
}

test("10000 seeded move sequences obey the three laws or name the law that refused them", () => {
	const rand = mulberry32(20261005);
	let accepted = 0;
	let refused = 0;
	for (let trial = 0; trial < 10_000; trial++) {
		const gross = 1 + cents(rand, 100000);
		const held = reduceLedger([], { kind: "Hold", gross: gross as never, at: instant("2026-11-01T11:12:00Z") });
		assert.equal("kind" in held, false);
		if ("kind" in held) return;
		let book: EscrowBook = held;
		const steps = 1 + cents(rand, 3);
		for (let step = 0; step < steps; step++) {
			const current: EscrowBook = book;
			const next = applyLedgerMove(current, move(rand, gross));
			if ("kind" in next && next.kind === "LAW_BREAK") {
				assert.equal(checkLaws(current), bookState(current));
				assert.ok(["conservation", "one_release", "refund_xor_payout", "order"].includes(next.law));
				refused += 1;
			} else if (!("kind" in next)) {
				const closed = checkLaws(next);
				assert.notEqual(typeof closed, "object");
				book = next;
				accepted += 1;
			}
		}
		assert.equal(checkLaws(book), bookState(book));
	}
	assert.equal(accepted, 5778);
	assert.equal(refused, 19309);
});

test("each refused move names its law on one concrete book", () => {
	const at = instant("2026-11-03T15:22:00Z");
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at });
	if ("kind" in held) throw new Error("Hold refused");
	const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at });
	if ("kind" in paid) throw new Error("Release refused");
	const short = reduceLedger(held, { kind: "Release", operatorNet: usd("300.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at });
	assert.deepEqual(short, { kind: "LAW_BREAK", law: "conservation" });
	assert.deepEqual(applyLedgerMove(paid, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at }), { kind: "LAW_BREAK", law: "one_release" });
	assert.deepEqual(applyLedgerMove(paid, { kind: "Refund", refunded: usd("420.00"), at }), { kind: "LAW_BREAK", law: "refund_xor_payout" });
	assert.deepEqual(applyLedgerMove([], { kind: "Refund", refunded: usd("420.00"), at }), { kind: "LAW_BREAK", law: "order" });
});
