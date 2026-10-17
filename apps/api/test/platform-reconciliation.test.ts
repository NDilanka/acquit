// The platform reconciliation's server side: each ledger line's PayPal object read under the right authority, the
// per-object cache, the refresh budget and its concurrency, Transaction Search as other activity, and the refusal of
// every holder but the platform role. PayPal is replaced by fakes that record each call, so these tests name the exact
// objects, windows, and pages the route asks for.

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBJECT_TTL_MS, RECONCILE_CACHE_MS, coalesced, paypalObjectRead, reconciliationService } from "../src/reconciliation.ts";
import type { LedgerTables, ObjectRead, TransactionFetch } from "../src/reconciliation.ts";
import { factOf } from "../../../packages/core/src/reconcile.ts";
import type { CaptureEventInput, LedgerLineInput, ObjectTarget, Reading } from "../../../packages/core/src/reconcile.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../packages/core/test/fixtures/paypal-reconcile/${name}`, import.meta.url), "utf8"));
const CAPTURE = "5JG93436967627628";
const RELEASED_CAPTURE = "20P48555BH2356736";
const PAYOUT_ITEM = "9gOgdaF5wfRSLI3kq8V7Boe9yIED2EzXBOksl3cCejMKFr60SucjaQN58AOIYo0=";
const MERCHANT = "MERCHANT_SANDBOX";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const MINUTE = 60_000;

/** One Transaction Search page as PayPal answers it. */
function page(rows: readonly unknown[], current: number, totalPages: number): unknown {
	return { transaction_details: rows, page: current, total_pages: totalPages, total_items: rows.length };
}

function row(id: string, value: string): unknown {
	return { transaction_info: { transaction_id: id, transaction_event_code: "T0001", transaction_initiation_date: "2026-10-12T10:00:00Z",
		transaction_amount: { currency_code: "USD", value } } };
}

/** A fake Transaction Search that records every (start, end, page) it is asked for. */
function fakeSearch(answer: (start: string, current: number) => unknown) {
	const calls: [string, string, number][] = [];
	const fetchPage: TransactionFetch = async (start, end, current) => {
		calls.push([start, end, current]);
		return answer(start, current);
	};
	return { calls, fetchPage };
}

/** A fake object reader: records each object asked for, optionally holds each read for a while, and answers from `answer`. */
function fakeObjects(answer: (target: ObjectTarget) => Reading, delayMs = 0) {
	const calls: ObjectTarget[] = [];
	let inFlight = 0;
	let peak = 0;
	const readObject: ObjectRead = async target => {
		calls.push(target);
		inFlight++;
		peak = Math.max(peak, inFlight);
		if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
		inFlight--;
		return answer(target);
	};
	return { calls, readObject, peak: () => peak };
}

const liveCapture = (): Reading => ({ state: "FOUND", fact: factOf("CAPTURE", fixture("capture-completed-with-fee.json")) });
const liveRelease = (): Reading => ({ state: "FOUND", fact: factOf("PAYOUT_ITEM", fixture("referenced-payout-success.json")) });

const EMPTY_SEARCH = () => fakeSearch(() => page([], 1, 1));
const hold = (entryId: string, captureId: string, cents = 37800): LedgerLineInput =>
	({ entryId, jobId: entryId.split("#")[0] ?? "job", kind: "HELD", cents, at: "2026-10-12T10:00:00Z", captureId, processorCents: null });
const event = (captureId: string, extra: Partial<CaptureEventInput> = {}): CaptureEventInput =>
	({ captureId, merchant: MERCHANT, refundId: null, payoutItemId: null, ...extra });

test("an empty ledger reads other activity for the last 31 days in two windows, and a read inside the cache window does not reach PayPal", async () => {
	const { calls, fetchPage } = fakeSearch(() => page([], 1, 1));
	const reconcile = reconciliationService({ fetchPage, readObject: fakeObjects(liveCapture).readObject });
	const empty: LedgerTables = { entries: [], events: [] };
	const first = await reconcile(empty, NOW);
	assert.deepEqual(calls, [
		["2026-09-12T00:00:00Z", "2026-10-13T00:00:00Z", 1],
		["2026-10-13T00:00:00Z", "2026-10-13T12:00:00Z", 1],
	]);
	assert.equal(first.other.state, "READ");
	if (first.other.state !== "READ") return;
	assert.equal(first.other.cached, false);

	const inside = await reconcile(empty, NOW + 30_000);
	assert.equal(inside.other.state === "READ" && inside.other.cached, true);
	assert.equal(inside.other.state === "READ" && inside.other.fetchedAt, "2026-10-13T12:00:00Z", "the cached read keeps its own time");
	assert.equal(calls.length, 2, "a read inside the search window is served from the cache");

	await reconcile(empty, NOW + RECONCILE_CACHE_MS + 1_000);
	assert.equal(calls.length, 4, "the first read after the search window goes back to PayPal");
});

test("each object is read once per refresh, and a settled capture is reused for five minutes", async () => {
	const objects = fakeObjects(liveCapture);
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject });
	const tables: LedgerTables = { entries: [
		hold("job_a#0", CAPTURE),
		{ entryId: "job_a#2", jobId: "job_a", kind: "FEE", cents: 6000, at: "2026-10-12T10:00:00Z", captureId: CAPTURE, processorCents: 1028 },
	], events: [event(CAPTURE)] };

	const first = await reconcile(tables, NOW);
	assert.deepEqual(first.rows.map(r => r.status), ["MATCHED", "MATCHED"]);
	assert.deepEqual(first.objects, { read: 1, cached: 0, budget: 60 }, "the hold and the fee share one capture read");
	assert.equal(objects.calls.length, 1);

	const inside = await reconcile(tables, NOW + 4 * MINUTE);
	assert.deepEqual(inside.objects, { read: 0, cached: 1, budget: 60 });
	assert.equal(objects.calls.length, 1, "a settled capture four minutes on is not read again");

	const after = await reconcile(tables, NOW + 6 * MINUTE);
	assert.deepEqual(after.objects, { read: 1, cached: 0, budget: 60 });
	assert.equal(objects.calls.length, 2, "a settled capture past its five minutes is read again");
	assert.equal(OBJECT_TTL_MS.CAPTURE, 5 * MINUTE);
});

test("a pending payout is never cached: the next refresh reads it again, and the line matches once PayPal settles it", async () => {
	const pendingItem = { ...(fixture("referenced-payout-success.json") as Record<string, unknown>), processing_state: { status: "PENDING" } };
	const answers: Reading[] = [{ state: "FOUND", fact: factOf("PAYOUT_ITEM", pendingItem) }, liveRelease()];
	const objects = fakeObjects(() => answers.shift() ?? liveRelease());
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject });
	const tables: LedgerTables = { entries: [{ entryId: "job_a#1", jobId: "job_a", kind: "RELEASED", cents: 36378, at: "2026-10-12T10:00:00Z", captureId: RELEASED_CAPTURE, processorCents: null }],
		events: [event(RELEASED_CAPTURE, { payoutItemId: PAYOUT_ITEM })] };

	const pending = await reconcile(tables, NOW);
	assert.deepEqual([pending.rows[0]?.status, pending.rows[0]?.reason], ["PENDING_AT_PAYPAL", "PAYPAL_PENDING"]);
	const settledNow = await reconcile(tables, NOW + MINUTE);
	assert.deepEqual([settledNow.rows[0]?.status, settledNow.rows[0]?.payoutTransactionId], ["MATCHED", "51P63583VW950112R"]);
	assert.equal(objects.calls.length, 2, "the pending reading was not reused");
});

test("the refresh's read budget caps PayPal reads: a line past it is not checked yet, never a mismatch", async () => {
	const objects = fakeObjects(liveCapture);
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject }, { budget: 2 });
	const tables: LedgerTables = { entries: [hold("job_a#0", "CAP-A"), hold("job_b#0", "CAP-B"), hold("job_c#0", "CAP-C")],
		events: [event("CAP-A"), event("CAP-B"), event("CAP-C")] };
	const result = await reconcile(tables, NOW);
	assert.deepEqual(result.counts, { matched: 2, pending: 0, mismatched: 0, notChecked: 1 });
	assert.deepEqual([result.rows[2]?.status, result.rows[2]?.reason], ["NOT_CHECKED", "NOT_READ_YET"]);
	assert.deepEqual(result.objects, { read: 2, cached: 0, budget: 2 });
	assert.equal(objects.calls.length, 2);
});

test("PayPal object reads run at most the concurrency at a time", async () => {
	const objects = fakeObjects(liveCapture, 2);
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject }, { concurrency: 2 });
	const ids = ["CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5"];
	const result = await reconcile({ entries: ids.map((id, i) => hold(`job_${i}#0`, id)), events: ids.map(id => event(id)) }, NOW);
	assert.equal(objects.calls.length, 5);
	assert.equal(objects.peak(), 2);
	assert.deepEqual(result.counts, { matched: 5, pending: 0, mismatched: 0, notChecked: 0 });
});

test("a failed Transaction Search is other activity not read, and the checked lines still show", async () => {
	const reconcile = reconciliationService({
		fetchPage: async () => { throw new Error("PayPal answered 500 for /v1/reporting/transactions."); },
		readObject: fakeObjects(liveCapture).readObject,
	});
	const result = await reconcile({ entries: [hold("job_a#0", CAPTURE)], events: [event(CAPTURE)] }, NOW);
	assert.deepEqual(result.other, { state: "NOT_READ", reason: "PAYPAL_UNREADABLE" });
	assert.deepEqual(result.counts, { matched: 1, pending: 0, mismatched: 0, notChecked: 0 });
});

test("a span longer than the search limit skips other activity with SPAN_TOO_LONG, and still checks the objects", async () => {
	const search = fakeSearch(() => page([], 1, 1));
	const objects = fakeObjects(liveCapture);
	const reconcile = reconciliationService({ fetchPage: search.fetchPage, readObject: objects.readObject });
	const old: LedgerTables = { entries: [{ ...hold("job_old#0", CAPTURE), at: "2023-10-13T12:00:00Z" }], events: [event(CAPTURE)] };
	const result = await reconcile(old, NOW);
	assert.deepEqual(result.other, { state: "NOT_READ", reason: "SPAN_TOO_LONG" });
	assert.equal(search.calls.length, 0, "no search page is asked for a span past the limit");
	assert.equal(result.counts.matched, 1);
});

test("Transaction Search rows a checked object claims are not other activity; the rest are, and are counted", async () => {
	const search = fakeSearch(() => page([row("51P63583VW950112R", "363.78"), row("TREASURY-1", "-15.15")], 1, 1));
	const reconcile = reconciliationService({ fetchPage: search.fetchPage, readObject: fakeObjects(liveRelease).readObject });
	const tables: LedgerTables = { entries: [{ entryId: "job_a#1", jobId: "job_a", kind: "RELEASED", cents: 36378, at: "2026-10-12T10:00:00Z", captureId: RELEASED_CAPTURE, processorCents: null }],
		events: [event(RELEASED_CAPTURE, { payoutItemId: PAYOUT_ITEM })] };
	const result = await reconcile(tables, NOW);
	assert.equal(result.other.state, "READ");
	if (result.other.state !== "READ") return;
	assert.equal(result.other.count, 1);
	assert.deepEqual(result.other.sample.map(t => t.transactionId), ["TREASURY-1"]);
});

test("a capture cached as COMPLETED is read again once a refund with no refund id names it, and the refund matches at once", async () => {
	const completed = fixture("capture-completed-with-fee.json");
	const refunded = { ...(completed as Record<string, unknown>), status: "REFUNDED" };
	let onPayPal: unknown = completed;
	const objects = fakeObjects(() => ({ state: "FOUND", fact: factOf("CAPTURE", onPayPal) }));
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject });
	const refundLine: LedgerLineInput = { entryId: "job_a#1", jobId: "job_a", kind: "REFUND", cents: 37800, at: "2026-10-12T10:00:00Z", captureId: CAPTURE, processorCents: null };

	const before = await reconcile({ entries: [hold("job_a#0", CAPTURE)], events: [event(CAPTURE)] }, NOW);
	assert.deepEqual(before.rows.map(r => r.status), ["MATCHED"]);

	// PayPal completes the full refund at t=1 s, and the job stores it with no refund id, so the capture now carries it.
	onPayPal = refunded;
	const after = await reconcile({ entries: [hold("job_a#0", CAPTURE), refundLine], events: [event(CAPTURE)] }, NOW + 1_000);
	assert.deepEqual(after.rows.map(r => [r.kind, r.status, r.reason]), [["HELD", "MATCHED", null], ["REFUND", "MATCHED", null]]);
	assert.deepEqual(after.objects, { read: 1, cached: 0, budget: 60 }, "the stale COMPLETED reading is replaced by one fresh read");
	assert.equal(objects.calls.length, 2);

	const later = await reconcile({ entries: [hold("job_a#0", CAPTURE), refundLine], events: [event(CAPTURE)] }, NOW + 2_000);
	assert.deepEqual(later.objects, { read: 0, cached: 1, budget: 60 }, "a REFUNDED reading answers the refund line from the cache");
	assert.equal(objects.calls.length, 2);
});

test("refreshes that join one COMPLETED read and each need it again share one fresh read", async () => {
	const completed = fixture("capture-completed-with-fee.json");
	const refunded = { ...(completed as Record<string, unknown>), status: "REFUNDED" };
	let answered = 0;
	const objects = fakeObjects(() => ({ state: "FOUND", fact: factOf("CAPTURE", answered++ === 0 ? completed : refunded) }), 5);
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject });
	const refundLine: LedgerLineInput = { entryId: "job_a#1", jobId: "job_a", kind: "REFUND", cents: 37800, at: "2026-10-12T10:00:00Z", captureId: CAPTURE, processorCents: null };
	const withRefund: LedgerTables = { entries: [hold("job_a#0", CAPTURE), refundLine], events: [event(CAPTURE)] };

	// The first refresh starts the capture read; the next two join it, and its COMPLETED answer cannot judge their refund line.
	const results = await Promise.all([
		reconcile({ entries: [hold("job_a#0", CAPTURE)], events: [event(CAPTURE)] }, NOW),
		reconcile(withRefund, NOW),
		reconcile(withRefund, NOW),
	]);
	for (const result of results.slice(1)) {
		assert.deepEqual(result.rows.map(r => [r.kind, r.status]), [["HELD", "MATCHED"], ["REFUND", "MATCHED"]]);
	}
	assert.equal(objects.calls.length, 2, "one shared first read and one shared fresh read");
});

test("a stale capture reading with no budget left is not checked yet, never a mismatch", async () => {
	const completed = fixture("capture-completed-with-fee.json");
	const refunded = { ...(completed as Record<string, unknown>), status: "REFUNDED" };
	let capOnPayPal: unknown = completed;
	const objects = fakeObjects(target => ({ state: "FOUND", fact: factOf("CAPTURE", target.id === CAPTURE ? capOnPayPal : completed) }));
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject }, { budget: 1 });
	await reconcile({ entries: [hold("job_a#0", CAPTURE)], events: [event(CAPTURE)] }, NOW);

	capOnPayPal = refunded;
	// The other capture is listed first, so the one read this refresh allows goes to it, and the refunded capture has none left.
	const result = await reconcile({
		entries: [hold("job_c#0", "CAP-2"), { entryId: "job_a#1", jobId: "job_a", kind: "REFUND", cents: 37800, at: "2026-10-12T10:00:00Z", captureId: CAPTURE, processorCents: null }, hold("job_a#0", CAPTURE)],
		events: [event(CAPTURE), event("CAP-2")],
	}, NOW + 1_000);
	assert.deepEqual(result.rows.map(r => [r.entryId, r.status, r.reason]), [
		["job_c#0", "MATCHED", null],
		["job_a#1", "NOT_CHECKED", "NOT_READ_YET"],
		["job_a#0", "NOT_CHECKED", "NOT_READ_YET"],
	]);
	assert.deepEqual(result.counts, { matched: 1, pending: 0, mismatched: 0, notChecked: 2 });
	assert.deepEqual(result.objects, { read: 1, cached: 0, budget: 1 });
	assert.deepEqual(objects.calls.map(t => t.id), [CAPTURE, "CAP-2"], "the stale capture was not read a second time");
});

test("the same capture id under another merchant is read under that merchant, never answered from the first merchant's reading", async () => {
	const objects = fakeObjects(target => (target.merchant === "MERCHANT_B" ? { state: "NOT_FOUND" } : liveCapture()));
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject });
	const first = await reconcile({ entries: [hold("job_a#0", CAPTURE)], events: [event(CAPTURE)] }, NOW);
	assert.deepEqual(first.rows.map(r => r.status), ["MATCHED"]);

	const second = await reconcile({ entries: [hold("job_b#0", CAPTURE)], events: [event(CAPTURE, { merchant: "MERCHANT_B" })] }, NOW + MINUTE);
	assert.deepEqual([second.rows[0]?.status, second.rows[0]?.reason], ["MISMATCHED", "NOT_AT_PAYPAL"]);
	assert.deepEqual(second.objects, { read: 1, cached: 0, budget: 60 });
	assert.deepEqual(objects.calls.map(t => t.merchant), [MERCHANT, "MERCHANT_B"]);
});

test("other activity reads at most four Transaction Search pages, and says so when the list is cut short", async () => {
	const search = fakeSearch((_start, current) => page([row(`T-${current}`, "1.00")], current, 10));
	const reconcile = reconciliationService({ fetchPage: search.fetchPage, readObject: fakeObjects(liveCapture).readObject });
	const result = await reconcile({ entries: [], events: [] }, NOW);
	assert.deepEqual(search.calls.map(([, , current]) => current), [1, 2, 3, 4]);
	assert.equal(result.other.state, "READ");
	if (result.other.state !== "READ") return;
	assert.equal(result.other.truncated, true);
	assert.equal(result.other.count, 4);
});

test("three refreshes at once read PayPal at most four at a time, and each object once", async () => {
	const objects = fakeObjects(liveCapture, 5);
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject });
	const ids = Array.from({ length: 90 }, (_, i) => `CAP-${String(i).padStart(2, "0")}`);
	const tables: LedgerTables = { entries: ids.map((id, i) => hold(`job_${i}#0`, id)), events: ids.map(id => event(id)) };
	const [tab1, tab2, tab3] = await Promise.all([reconcile(tables, NOW), reconcile(tables, NOW), reconcile(tables, NOW)]);
	assert.equal(objects.peak(), 4, "one cap holds across the three refreshes");
	assert.equal(objects.calls.length, 90);
	assert.equal(new Set(objects.calls.map(t => t.id)).size, 90, "no object is read twice");
	assert.deepEqual([tab1.objects, tab2.objects, tab3.objects], [
		{ read: 60, cached: 0, budget: 60 },
		{ read: 30, cached: 60, budget: 60 },
		{ read: 0, cached: 90, budget: 60 },
	]);
	assert.deepEqual([tab1.counts, tab2.counts, tab3.counts].map(c => [c.matched, c.notChecked]), [[60, 30], [90, 0], [90, 0]]);
});

test("a target that keeps failing cannot starve the targets after it: each refresh starts where the last one stopped", async () => {
	const id = (i: number) => `CAP-${String(i).padStart(2, "0")}`;
	const failing = new Set(Array.from({ length: 60 }, (_, i) => id(i)));
	const objects = fakeObjects(target => (failing.has(target.id) ? { state: "UNAVAILABLE", detail: "PayPal answered 503" } : liveCapture()));
	const reconcile = reconciliationService({ fetchPage: EMPTY_SEARCH().fetchPage, readObject: objects.readObject });
	const ids = Array.from({ length: 90 }, (_, i) => id(i));
	const tables: LedgerTables = { entries: ids.map((x, i) => hold(`job_${i}#0`, x)), events: ids.map(x => event(x)) };

	const first = await reconcile(tables, NOW);
	assert.deepEqual(first.counts, { matched: 0, pending: 0, mismatched: 0, notChecked: 90 });
	assert.equal(first.objects.read, 60);
	const second = await reconcile(tables, NOW + MINUTE);
	assert.deepEqual(second.counts, { matched: 30, pending: 0, mismatched: 0, notChecked: 60 }, "the targets past the first 60 read on the second refresh");
	assert.deepEqual(second.rows.slice(60).map(r => r.status), Array(30).fill("MATCHED"));
});

test("refreshes that arrive while one runs wait for it, and those that arrive meanwhile share one run on the latest ledger", async () => {
	const log: string[] = [];
	const refresh = coalesced(async (tables: string) => {
		log.push(`start ${tables}`);
		await new Promise(resolve => setTimeout(resolve, 5));
		log.push(`end ${tables}`);
		return tables;
	});
	const first = refresh("one");
	await new Promise(resolve => setTimeout(resolve, 1));
	const second = refresh("two");
	const third = refresh("three");
	assert.deepEqual(await Promise.all([first, second, third]), ["one", "three", "three"]);
	assert.deepEqual(log, ["start one", "end one", "start three", "end three"]);
});

// ---- the object reader: which authority reads which object, and what its refusals become --------------------------

type Seen = { readonly path: string; readonly assertion: string | null };

/** A fake fetch: answers the OAuth token, records every other request's path and assertion, and answers from `answer`. */
function fakeFetch(answer: (url: string) => Response) {
	const seen: Seen[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "fake-access-for-tests", expires_in: 3600 });
		const headers = new Headers(init?.headers);
		seen.push({ path: url.replace(/^https?:\/\/[^/]+/, ""), assertion: headers.get("PayPal-Auth-Assertion") });
		return answer(url);
	}) as typeof fetch;
	return { seen, fetchImpl };
}

const CONFIG = { clientId: "test-client-id", clientSecret: "test-secret" };

test("a capture is read under its merchant's assertion, and a payout item under the platform token alone", async () => {
	const { seen, fetchImpl } = fakeFetch(url => Response.json(url.includes("/v2/payments/captures/") ? fixture("capture-completed-with-fee.json") : fixture("referenced-payout-success.json")));
	const read = paypalObjectRead(CONFIG, fetchImpl);
	const capture = await read({ kind: "CAPTURE", id: CAPTURE, merchant: MERCHANT });
	const payout = await read({ kind: "PAYOUT_ITEM", id: PAYOUT_ITEM, merchant: null });
	assert.deepEqual(capture, liveCapture());
	assert.deepEqual(payout, liveRelease());
	assert.deepEqual(seen, [
		{ path: "/v2/payments/captures/5JG93436967627628", assertion: "eyJhbGciOiJub25lIn0=.eyJpc3MiOiJ0ZXN0LWNsaWVudC1pZCIsInBheWVyX2lkIjoiTUVSQ0hBTlRfU0FOREJPWCJ9." },
		{ path: "/v1/payments/referenced-payouts-items/9gOgdaF5wfRSLI3kq8V7Boe9yIED2EzXBOksl3cCejMKFr60SucjaQN58AOIYo0%3D", assertion: null },
	]);
});

test("PayPal's 404 is NOT_FOUND; a 5xx or a 403 is UNAVAILABLE and names only the status, never PayPal's body", async () => {
	const statuses: Record<string, number> = { [CAPTURE]: 404 };
	const { fetchImpl } = fakeFetch(url => {
		const id = url.split("/").at(-1) ?? "";
		const status = statuses[id] ?? 503;
		return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "account detail that must not leak" }), { status });
	});
	const read = paypalObjectRead(CONFIG, fetchImpl);
	assert.deepEqual(await read({ kind: "CAPTURE", id: CAPTURE, merchant: MERCHANT }), { state: "NOT_FOUND" });
	assert.deepEqual(await read({ kind: "CAPTURE", id: "CAP-DOWN", merchant: MERCHANT }), { state: "UNAVAILABLE", detail: "PayPal answered 503" });
	statuses["CAP-FORBIDDEN"] = 403;
	assert.deepEqual(await read({ kind: "CAPTURE", id: "CAP-FORBIDDEN", merchant: MERCHANT }), { state: "UNAVAILABLE", detail: "PayPal answered 403" });
});

// ---- the route over real HTTP: the platform role alone may read it, and nothing is fetched for anyone else ----

const root = join(import.meta.dirname, "..");

function bootServer(port: number, dbPath: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => rejectBoot(new Error(`server did not boot: ${out} ${err}`)), 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			out += String(chunk);
			if (out.includes("Acquit API:")) { clearTimeout(timer); resolveBoot(child); }
		});
		child.stderr.on("data", (chunk: Buffer) => { err += String(chunk); });
		child.on("exit", (code) => { clearTimeout(timer); rejectBoot(new Error(`server exited early (${code}): ${out} ${err}`)); });
	});
}

const post = (port: number, path: string, payload: unknown) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("the reconciliation route refuses anonymous and non-platform sessions before it reads PayPal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-reconcile-"));
	const port = 4898;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const anonymous = await fetch(`http://127.0.0.1:${port}/api/platform/reconciliation`);
		assert.equal(anonymous.status, 401);

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		const client = await fetch(`http://127.0.0.1:${port}/api/platform/reconciliation`, { headers: { authorization: `Bearer ${clientToken}` } });
		assert.equal(client.status, 403);
		assert.deepEqual(await client.json(), { error: "PLATFORM_ONLY" });
	} finally {
		// Windows keeps the SQLite file locked until the server process has exited.
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
