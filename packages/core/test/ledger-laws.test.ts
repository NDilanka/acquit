import assert from "node:assert/strict";
import test from "node:test";
import { checkLaws, reduceLedger, usd } from "../src/ledger.ts";
import type { EscrowBook, LawBreak, LedgerLaw, LedgerLine, LedgerMove } from "../src/ledger.ts";
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

function bookState(book: readonly unknown[]): "OPEN" | "PAID" | "REFUNDED" {
	if (book.length === 3) return "PAID";
	if (book.length === 2) return "REFUNDED";
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
			const next: EscrowBook | LawBreak = reduceLedger(current, move(rand, gross));
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
	assert.deepEqual(reduceLedger(paid, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at }), { kind: "LAW_BREAK", law: "one_release" });
	assert.deepEqual(reduceLedger(paid, { kind: "Refund", refunded: usd("420.00"), at }), { kind: "LAW_BREAK", law: "refund_xor_payout" });
	assert.deepEqual(reduceLedger([], { kind: "Refund", refunded: usd("420.00"), at }), { kind: "LAW_BREAK", law: "order" });
});

test("checkLaws names the exact law on mutated and illegal books", () => {
	const at = instant("2026-11-03T15:22:00Z");
	const held: LedgerLine = { kind: "HELD", cents: usd("420.00"), at };
	const released: LedgerLine = { kind: "RELEASED", cents: usd("360.00"), at };
	const fee: LedgerLine = { kind: "FEE", cents: usd("60.00"), processor: usd("15.15"), acquit: usd("44.85"), at };
	const refund: LedgerLine = { kind: "REFUND", cents: usd("420.00"), at };
	const broken = (lines: readonly LedgerLine[]): LedgerLaw => {
		const result = checkLaws(lines);
		assert.equal(typeof result, "object");
		return (result as LawBreak).law;
	};
	// A payout and a refund on one book is the disposition violation, even when the sums conserve.
	assert.equal(broken([held, released, fee, refund]), "refund_xor_payout");
	assert.equal(broken([held, refund, released, fee]), "refund_xor_payout");
	assert.equal(broken([held, released, fee, { kind: "REFUND", cents: usd("0.00"), at }]), "refund_xor_payout");
	// A second RELEASED line is a double release.
	assert.equal(broken([held, released, fee, released]), "one_release");
	// Sums that do not add up to HELD break conservation, including a FEE whose split disagrees.
	assert.equal(broken([held, { kind: "RELEASED", cents: usd("300.00"), at }, fee]), "conservation");
	assert.equal(broken([held, released, { kind: "FEE", cents: usd("60.00"), processor: usd("15.15"), acquit: usd("44.00"), at }]), "conservation");
	assert.equal(broken([held, { kind: "REFUND", cents: usd("400.00"), at }]), "conservation");
	// Valid sums in the wrong shape break order.
	assert.equal(broken([released, fee, held]), "order");
	assert.equal(broken([refund, held]), "order");
	assert.equal(broken([held, held]), "order");
	// Zero-value books match the reducer, which refuses a zero hold.
	assert.deepEqual(reduceLedger([], { kind: "Hold", gross: usd("0.00"), at }), { kind: "LAW_BREAK", law: "conservation" });
	assert.equal(broken([{ kind: "HELD", cents: usd("0.00"), at }]), "conservation");
	assert.equal(broken([{ kind: "HELD", cents: usd("0.00"), at }, { kind: "RELEASED", cents: usd("0.00"), at },
		{ kind: "FEE", cents: usd("0.00"), processor: usd("0.00"), acquit: usd("0.00"), at }]), "conservation");
	assert.equal(broken([{ kind: "HELD", cents: usd("0.00"), at }, { kind: "REFUND", cents: usd("0.00"), at }]), "conservation");
	// Negative, fractional, and unsafe cents are illegal wherever they appear.
	assert.equal(broken([{ kind: "HELD", cents: -1 as never, at }]), "conservation");
	assert.equal(broken([{ kind: "HELD", cents: 1.5 as never, at }]), "conservation");
	assert.equal(broken([{ kind: "HELD", cents: Number.MAX_SAFE_INTEGER + 1 as never, at }]), "conservation");
	assert.equal(broken([held, released, { kind: "FEE", cents: usd("60.00"), processor: -1515 as never, acquit: usd("75.15"), at }]), "conservation");
	// The reachable books are untouched.
	assert.equal(checkLaws([]), "OPEN");
	assert.equal(checkLaws([held]), "OPEN");
	assert.equal(checkLaws([held, released, fee]), "PAID");
	assert.equal(checkLaws([held, refund]), "REFUNDED");
});

test("a stored fee component that is not a safe integer is refused, not read as a zero", () => {
	const at = instant("2026-11-03T15:22:00Z");
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at });
	if ("kind" in held) throw new Error("Hold refused");
	const released: LedgerLine = { kind: "RELEASED", cents: usd("360.00"), at };
	// Round four's false green verbatim: the checker read the null processor as a zero fee and
	// null + 6000 coerced the split into 6000, so the sums conserved and it printed PAID.
	const stored = [
		{ kind: "HELD", cents: 42000 },
		{ kind: "RELEASED", cents: 36000 },
		{ kind: "FEE", cents: 6000, processor: null, acquit: 6000 },
	];
	const refusal = reduceLedger(held, { kind: "Release", operatorNet: 36000 as never, processorFee: null as never, platformFee: 6000 as never, at });
	assert.deepEqual(refusal, { kind: "LAW_BREAK", law: "conservation" });
	assert.deepEqual(checkLaws(stored as unknown as readonly LedgerLine[]), refusal);
	const badValues: Array<[string, unknown]> = [["undefined", undefined], ['the string "0"', "0"], ["NaN", Number.NaN], ["negative", -1], ["fractional", 0.5]];
	for (const [name, bad] of badValues) {
		for (const fields of [{ processor: bad, acquit: 6000 }, { processor: 6000, acquit: bad }]) {
			const book = [held[0], released, { kind: "FEE", cents: 6000, processor: fields.processor, acquit: fields.acquit, at }] as unknown as readonly LedgerLine[];
			const verdict = checkLaws(book);
			assert.deepEqual(verdict, { kind: "LAW_BREAK", law: "conservation" }, `a ${name} fee component must not be coerced`);
			assert.deepEqual(verdict, reduceLedger(held, { kind: "Release", operatorNet: 36000 as never,
				processorFee: fields.processor as never, platformFee: fields.acquit as never, at }), `a ${name} fee component`);
		}
	}
});

test("300 seeded stored payout books refuse every fuzzed fee component and agree with the reducer", () => {
	const rand = mulberry32(20261103);
	const at = instant("2026-11-03T15:22:00Z");
	const badValues: readonly unknown[] = [undefined, null, "0", "6000", Number.NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, true, {}];
	let books = 0;
	let mutations = 0;
	for (let trial = 0; trial < 300; trial++) {
		const heldCents = 1 + cents(rand, 100000);
		const releasedCents = cents(rand, heldCents);
		const share = heldCents - releasedCents;
		// Two books in three put the whole fee on one side, so a null component is the only
		// thing that could make the split look conserved.
		const shape = cents(rand, 2);
		const processor = shape === 0 ? 0 : shape === 1 ? share : cents(rand, share);
		const acquit = share - processor;
		const held: LedgerLine = { kind: "HELD", cents: heldCents, at };
		const released: LedgerLine = { kind: "RELEASED", cents: releasedCents, at };
		const fee = { cents: processor + acquit, processor, acquit };
		assert.equal(checkLaws([held, released, { kind: "FEE", ...fee, at }] as unknown as readonly LedgerLine[]), "PAID");
		books += 1;
		const reduced = reduceLedger([], { kind: "Hold", gross: heldCents as never, at });
		if ("kind" in reduced) throw new Error("Hold refused");
		for (const field of ["cents", "processor", "acquit"] as const) {
			for (const bad of badValues) {
				const fuzzed = { ...fee, [field]: bad };
				const verdict = checkLaws([held, released, { kind: "FEE", ...fuzzed, at }] as unknown as readonly LedgerLine[]);
				assert.deepEqual(verdict, { kind: "LAW_BREAK", law: "conservation" }, `a ${String(bad)} ${field} must not be coerced`);
				if (field !== "cents") {
					assert.deepEqual(verdict, reduceLedger(reduced, { kind: "Release", operatorNet: releasedCents as never,
						processorFee: fuzzed.processor as never, platformFee: fuzzed.acquit as never, at }), `a ${String(bad)} ${field}`);
				}
				mutations += 1;
			}
		}
	}
	assert.equal(books, 300);
	assert.equal(mutations, 9000);
});

test("usd rejects negative, fractional-cent, and unsafe amounts", () => {
	for (const bad of ["-1.00", "-0.01", "1.001", "0.005", "1e3", "abc", "1.", ".50", "1,000.00", "90071992547409.92"]) {
		assert.throws(() => usd(bad), /Invalid|Unsafe/);
	}
	assert.equal(usd("0.00"), 0);
	assert.equal(usd("9007199254740.91"), 900719925474091);
});
test("checkLaws reports the reducer's law at the first illegal move", () => {
	const at = instant("2026-11-03T15:22:00Z");
	const held = reduceLedger([], { kind: "Hold", gross: usd("420.00"), at });
	if ("kind" in held) throw new Error("Hold refused");
	const refunded = reduceLedger(held, { kind: "Refund", refunded: usd("420.00"), at });
	if ("kind" in refunded) throw new Error("Refund refused");
	const refund: LedgerLine = { kind: "REFUND", cents: usd("420.00"), at };
	assert.deepEqual(checkLaws([refund]), reduceLedger([], { kind: "Refund", refunded: refund.cents, at }));
	assert.deepEqual(checkLaws([...refunded, refund]), reduceLedger(refunded, { kind: "Refund", refunded: refund.cents, at }));
	assert.deepEqual(checkLaws([...refunded, { ...refund, cents: usd("1.00") }]), { kind: "LAW_BREAK", law: "order" });
	// A later duplicate release cannot override an earlier illegal refund.
	const paid = reduceLedger(held, { kind: "Release", operatorNet: usd("360.00"), processorFee: usd("15.15"), platformFee: usd("44.85"), at });
	if ("kind" in paid) throw new Error("Release refused");
	assert.deepEqual(checkLaws([...paid, refund, paid[1], paid[2]]), { kind: "LAW_BREAK", law: "refund_xor_payout" });
});
test("checkLaws refuses a line that is not a book entry instead of throwing", () => {
	const broken = (lines: unknown): LawBreak => {
		const result = checkLaws(lines as readonly LedgerLine[]);
		assert.equal(typeof result, "object");
		return result as LawBreak;
	};
	const at = instant("2026-11-03T15:22:00Z");
	const held: LedgerLine = { kind: "HELD", cents: usd("420.00"), at };
	assert.deepEqual(broken([null]), { kind: "LAW_BREAK", law: "order" });
	assert.deepEqual(broken([held, null]), { kind: "LAW_BREAK", law: "order" });
	assert.deepEqual(broken([undefined, held]), { kind: "LAW_BREAK", law: "order" });
	assert.deepEqual(broken([42]), { kind: "LAW_BREAK", law: "order" });
	assert.deepEqual(broken("HELD"), { kind: "LAW_BREAK", law: "order" });
	assert.equal(checkLaws([held]), "OPEN");
});
