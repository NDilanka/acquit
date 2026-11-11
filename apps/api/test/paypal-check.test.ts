// The PayPal check at work start: what PayPal's order answer means for the money, the order read under the merchant's
// assertion, and the check's rules. One check per job, no read without credentials, a slow or failed read recorded as
// unavailable, and nothing thrown into the run.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { MerchantId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { authAssertion } from "../../../packages/core/src/paypal.ts";
import { PayPalHttpError } from "../../../packages/mcp/src/paypal.ts";
import { answerOf, createPayPalCheck, paypalOrderRead, type OrderRead } from "../src/paypal-check.ts";

const merchant = "DEVON-MERCHANT" as MerchantId;
const instantNow = "2026-11-10T21:00:00.000Z";
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

const completed = (orderId = "ORDER1") => ({
	id: orderId, status: "COMPLETED",
	purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "42.00" } }] } }],
});

function jobRow(id: string, options: { status?: string; payee?: MerchantId } = {}): JobRow {
	return { id, state: { status: options.status ?? "IN_PROGRESS",
		escrow: { capture: { orderId: "ORDER1" }, payee: { payee: options.payee ?? merchant } } } } as unknown as JobRow;
}

test("a completed capture with PayPal's amount is held", () => {
	assert.deepEqual(answerOf(completed(), "ORDER1"), { outcome: "HELD", orderStatus: "COMPLETED", captureStatus: "COMPLETED",
		heldValue: "42.00", heldCurrency: "USD", reason: null });
});

test("a capture that is not completed is not held, and the reason names PayPal's status", () => {
	const pending = { id: "ORDER1", status: "PAYER_ACTION_REQUIRED",
		purchase_units: [{ payments: { captures: [{ status: "PENDING", amount: { currency_code: "USD", value: "42.00" } }] } }] };
	assert.deepEqual(answerOf(pending, "ORDER1"), { outcome: "NOT_HELD", orderStatus: "PAYER_ACTION_REQUIRED", captureStatus: "PENDING",
		heldValue: null, heldCurrency: null, reason: "CAPTURE_PENDING" });
});

test("an order with no capture is not held, and the reason names the order's status", () => {
	assert.deepEqual(answerOf({ id: "ORDER1", status: "APPROVED", purchase_units: [{}] }, "ORDER1"), { outcome: "NOT_HELD",
		orderStatus: "APPROVED", captureStatus: null, heldValue: null, heldCurrency: null, reason: "ORDER_APPROVED" });
});

test("an answer for another order, or a completed capture with no amount, is unavailable", () => {
	assert.equal(answerOf(completed("ORDER2"), "ORDER1").reason, "ORDER_MISMATCH");
	const noAmount = { id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "COMPLETED" }] } }] };
	assert.deepEqual(answerOf(noAmount, "ORDER1"), { outcome: "UNAVAILABLE", orderStatus: null, captureStatus: null,
		heldValue: null, heldCurrency: null, reason: "AMOUNT_MISSING" });
});

test("the order read is a GET of the order under the merchant's assertion, with the PayPal token", async () => {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		if (href.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "TOKEN-FOR-TEST", expires_in: 3600 });
		calls.push({ url: href, headers: { ...(init?.headers as Record<string, string>) } });
		return Response.json(completed());
	}) as typeof fetch;
	const read = paypalOrderRead({ clientId: "CLIENT-FOR-TEST", clientSecret: "SECRET-FOR-TEST" }, fakeFetch);
	assert.deepEqual(await read("ORDER1", merchant), completed());
	assert.equal(calls.length, 1);
	assert.equal(new URL(calls[0]!.url).pathname, "/v2/checkout/orders/ORDER1");
	assert.equal(calls[0]!.headers["PayPal-Auth-Assertion"], authAssertion("CLIENT-FOR-TEST", merchant));
	assert.equal(calls[0]!.headers.Authorization, "Bearer TOKEN-FOR-TEST");
});

test("a funded job's first push records PayPal's held amount, read under the job's merchant", async () => {
	const seen: unknown[][] = [];
	const read: OrderRead = async (orderId, payee) => { seen.push([orderId, payee]); return completed(); };
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, log: () => {} });
	check.start(jobRow("job_a"));
	await settle();
	assert.deepEqual(check.recordsOf(["job_a"]).get("job_a"), { jobId: "job_a", orderId: "ORDER1", checkedAt: instantNow,
		outcome: "HELD", orderStatus: "COMPLETED", captureStatus: "COMPLETED", heldValue: "42.00", heldCurrency: "USD", reason: null });
	assert.deepEqual(seen, [["ORDER1", merchant]]);
});

test("start returns at once, and nothing is recorded until the read settles", async () => {
	let release: (value: unknown) => void = () => {};
	const read: OrderRead = () => new Promise(resolve => { release = resolve; });
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, log: () => {} });
	check.start(jobRow("job_a"));
	assert.equal(check.recordsOf(["job_a"]).size, 0);
	release(completed());
	await settle();
	assert.equal(check.recordsOf(["job_a"]).get("job_a")?.outcome, "HELD");
});

test("a read that outlasts the timeout records the check as unavailable", async () => {
	const read: OrderRead = () => new Promise(() => {});
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, timeoutMs: 20, log: () => {} });
	check.start(jobRow("job_a"));
	await new Promise(resolve => setTimeout(resolve, 80));
	const record = check.recordsOf(["job_a"]).get("job_a");
	assert.equal(record?.outcome, "UNAVAILABLE");
	assert.equal(record?.reason, "TIMEOUT");
	assert.equal(record?.heldValue, null);
});

test("a failed read records its reason without the error's text", async () => {
	const lines: string[] = [];
	const read: OrderRead = async () => { throw new Error("FAKE-PUSH-TOKEN-FOR-TEST was refused"); };
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, log: line => lines.push(line) });
	check.start(jobRow("job_a"));
	await settle();
	const record = check.recordsOf(["job_a"]).get("job_a");
	assert.equal(record?.outcome, "UNAVAILABLE");
	assert.equal(record?.reason, "READ_FAILED");
	assert.ok(!JSON.stringify(record).includes("FAKE-PUSH-TOKEN-FOR-TEST"));
	assert.ok(!lines.join("\n").includes("FAKE-PUSH-TOKEN-FOR-TEST"));
});

test("a PayPal HTTP refusal records its status", async () => {
	const read: OrderRead = async () => { throw new PayPalHttpError(404, "/v2/checkout/orders/ORDER1"); };
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, log: () => {} });
	check.start(jobRow("job_a"));
	await settle();
	assert.equal(check.recordsOf(["job_a"]).get("job_a")?.reason, "PAYPAL_HTTP_404");
});

test("a job is checked once: no second read while one runs, and none after a record", async () => {
	let reads = 0;
	let release: (value: unknown) => void = () => {};
	const read: OrderRead = () => { reads++; return new Promise(resolve => { release = resolve; }); };
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, log: () => {} });
	check.start(jobRow("job_a"));
	check.start(jobRow("job_a"));
	release(completed());
	await settle();
	check.start(jobRow("job_a"));
	await settle();
	assert.equal(reads, 1);
});

test("with no PayPal read, start does nothing and records nothing", async () => {
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read: null, now: () => instantNow, log: () => {} });
	check.start(jobRow("job_a"));
	await settle();
	assert.equal(check.recordsOf(["job_a"]).size, 0);
});

test("only a job in progress is checked", async () => {
	let reads = 0;
	const read: OrderRead = async () => { reads++; return completed(); };
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, log: () => {} });
	check.start(jobRow("job_a", { status: "VERIFIED" }));
	await settle();
	assert.equal(reads, 0);
});

test("a malformed job row never throws into the run", () => {
	const lines: string[] = [];
	const read: OrderRead = async () => completed();
	const check = createPayPalCheck({ db: new DatabaseSync(":memory:"), read, now: () => instantNow, log: line => lines.push(line) });
	assert.doesNotThrow(() => check.start({ id: "job_a", state: null } as unknown as JobRow));
	assert.match(lines.join("\n"), /PayPal check did not start/);
});

test("a claim cut off by a restart is recorded as unavailable, and its order is never read again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-paypal-check-"));
	const path = join(dir, "acquit.db");
	let second: DatabaseSync | null = null;
	try {
		// The first process claims the job, then dies before its read settles: its handle closes, so no answer is written.
		let firstReads = 0;
		const first = new DatabaseSync(path);
		const gone = createPayPalCheck({ db: first, read: () => { firstReads++; return new Promise(() => {}); }, now: () => instantNow,
			timeoutMs: 20, log: () => {} });
		gone.start(jobRow("job_a"));
		first.close();
		await new Promise(resolve => setTimeout(resolve, 40));

		// The restarted process finds the claim with no answer, and the retry of the push starts no read.
		second = new DatabaseSync(path);
		let secondReads = 0;
		const restarted = createPayPalCheck({ db: second, read: async () => { secondReads++; return completed(); }, now: () => instantNow,
			log: () => {} });
		const cut = restarted.recordsOf(["job_a"]).get("job_a");
		assert.equal(cut?.outcome, "UNAVAILABLE");
		assert.equal(cut?.reason, "INTERRUPTED");
		restarted.start(jobRow("job_a"));
		await settle();
		assert.equal(firstReads, 1);
		assert.equal(secondReads, 0, "a restart never reads the order a second time");
		assert.equal(restarted.recordsOf(["job_a"]).get("job_a")?.outcome, "UNAVAILABLE");
	} finally {
		second?.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
