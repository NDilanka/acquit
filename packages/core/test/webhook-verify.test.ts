// P1 webhook signature verification. The signed route calls PayPal's verify-webhook-signature after the
// parse and before the resource re-read, and only `SUCCESS` proceeds. A refusal is a terminal 4xx with a
// logged reason code, an outage answers a retryable 5xx, and neither applies anything. Every fault path
// here is an injected transport: the route tests script the PayPal port's verdict, and the client tests
// script the wire the verify call travels. No production switch can fake a verdict.

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { usd } from "../src/ledger.ts";
import { applySystemCommand, executeCommand, ingestPayPalWebhook } from "../src/effects.ts";
import type { Ports } from "../src/effects.ts";
import { instant, hours, parseRequestKey } from "../src/ids.ts";
import type { AgentId, CaptureId, ClientId, MerchantId, OperatorId, OrderId } from "../src/ids.ts";
import { createPayPal, parseWebhookEnvelope } from "../src/paypal.ts";
import type { Bps, ResourceRead, WebhookVerifyOutcome } from "../src/paypal.ts";
import { creditWeek, reduceCredits } from "../src/credits.ts";
import type { CreditAccount, Credits } from "../src/credits.ts";
import type { HiddenContract } from "../src/seed-data.ts";
import { exampleContract } from "./hidden-fixture.ts";
import { SqliteStore } from "../src/store.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";

const now = instant("2026-10-06T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const platform = "LA4PH2WMNKTDN" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const devon: Actor = { role: "OPERATOR", operatorId: "devon-ops" as OperatorId, tenant: null };
const requestKey = () => parseRequestKey(randomUUID());
const openCommand: UserCommand = { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
	budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z") };
const deploymentContract: HiddenContract = { ids: exampleContract.ids, digest: "c0".repeat(32) as HiddenContract["digest"] };

function jobOf(outcome: CommandOutcome) {
	assert.notEqual(outcome.kind, "DENIED");
	if (outcome.kind === "DENIED" || outcome.result.kind !== "JOB" && outcome.result.kind !== "BID") throw new Error("Expected job result");
	return outcome.result.job;
}
function emptyAccount(operator = "devon-ops" as OperatorId): CreditAccount {
	return { operator, version: 0 as CreditAccount["version"], balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
}
function grant(operator?: OperatorId): CreditAccount {
	const account = reduceCredits(emptyAccount(operator), { kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
	if (typeof account === "string") throw new Error(account);
	return account;
}

/** One delivery as posted to the signed route. */
const captureEnvelope = (eventId: string, captureId = "TESTCAPTURE") => JSON.stringify({ id: eventId,
	event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: captureId } });
const delivered = (ports: Ports, body: string) => ingestPayPalWebhook(ports, new Request("http://localhost:4310/paypal/webhook", { method: "POST", body }));
const recordedOutcome = (store: SqliteStore, id: string): string | null => {
	const row = store.db.prepare("SELECT outcome FROM webhook_events WHERE id = ?").get(id) as { outcome: string } | undefined;
	return row?.outcome ?? null;
};
const outboxRows = (store: SqliteStore): number =>
	Number((store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n);

/**
 * The route's ports, with the PayPal port scripted. `verdicts` are consumed one per delivery; the
 * `calls` log is the order the route consulted the port in. A resource read that is never registered
 * leaves the re-read answering UNKNOWN, so an "applies nothing" assertion cannot pass by accident.
 */
function fixture() {
	const store = new SqliteStore(":memory:");
	for (const [handle, kind, agentName, receipts] of [
		["devon-ops", "INDEPENDENT", "ts-bugfixer", 0], ["house-tsfix", "HOUSE", "house-ts-fixer", 41],
	] as const) {
		const row: OperatorRow = { id: handle as OperatorId, handle, kind, version: 0 as OperatorRow["version"],
			payouts: { kind: "READY", merchant, connectedAt: now } };
		const agent: Agent = { id: agentName as AgentId, owner: row.id, name: agentName,
			runner: "claude-code", promptDigest: "digest" as Agent["promptDigest"], tools: [] };
		const credits = kind === "HOUSE" ? emptyAccount(row.id) : grant(row.id);
		store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), receipts);
		store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(row.id, credits.version, JSON.stringify(credits));
	}
	const capture = {
		orderId: "TESTORDER" as OrderId, captureId: "TESTCAPTURE" as CaptureId, payee: merchant,
		disbursement: "DELAYED" as const, gross: usd("420.00"), processorFee: usd("15.15"),
		platformFee: usd("44.85"), sellerNet: usd("360.00"), capturedAt: now,
	};
	const unimplemented = async (): Promise<never> => { throw new Error("not implemented"); };
	const reads = new Map<string, ResourceRead>();
	const calls: string[] = [];
	const verdicts: WebhookVerifyOutcome[] = [];
	const ports: Ports = { store, feeModel: model, clientRepository: "maya-client/invoice-app", hiddenContract: deploymentContract,
		clock: { now: () => now }, verifier: { start: unimplemented, parseCallback: unimplemented },
		github: { merge: unimplemented }, alerts: { raise: unimplemented }, paypal: {
			dispatch: async call => {
				if (call.kind === "CREATE_ORDER") return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId: capture.orderId, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER" } };
				if (call.kind === "CAPTURE") return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture } };
				throw new Error("Unexpected test effect");
			},
			reconcile: unimplemented, getOrder: unimplemented,
			parseWebhook: async raw => parseWebhookEnvelope(raw),
			readResource: async resource => { calls.push("read"); return reads.get(resource.id) ?? { kind: "UNKNOWN" }; },
			verifyWebhookDelivery: async () => { calls.push("verify"); return verdicts.shift() ?? { kind: "VERIFIED" }; },
		} };
	return { store, ports, capture, calls, verdicts, read: (id: string, read: ResourceRead) => { reads.set(id, read); } };
}

/** A job whose buyer approved but whose capture answer was lost: it waits for the capture event. */
async function capturingFixture() {
	const f = fixture();
	const job = jobOf(await executeCommand(f.ports, maya, requestKey(), openCommand));
	const bid = await executeCommand(f.ports, devon, requestKey(), { type: "PlaceBid", jobId: job.id,
		price: usd("400.00"), eta: hours(48), agent: "ts-bugfixer" as AgentId, pitch: "test" });
	if (bid.kind === "DENIED" || bid.result.kind !== "BID") throw new Error("Missing bid");
	await executeCommand(f.ports, maya, requestKey(), { type: "AcceptBid", jobId: job.id, bidId: bid.result.bid });
	await applySystemCommand(f.ports, { type: "BuyerApproved", jobId: job.id, orderId: f.capture.orderId }, null, null);
	return { f, jobId: job.id };
}

const configuredPayPal = { apiBase: "https://api-m.sandbox.paypal.com" as const, webOrigin: "http://localhost:5243",
	clientId: "test", secret: "test", webhookId: "WH-CONFIGURED-ID", partnerMerchant: platform, feeModel: model };
/** The five transmission headers PayPal signs every delivery with. */
const transmission = { "paypal-transmission-id": "TR-4GLX513", "paypal-transmission-time": "2026-10-06T12:00:00Z",
	"paypal-transmission-sig": "recorded-signature-bytes", "paypal-auth-algo": "SHA256withRSA",
	"paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-RECORDED" };
type WireCall = { readonly method: string; readonly path: string; readonly auth: string | null; readonly body: unknown };
/** The token mint's body is a form, not JSON; a body that does not parse is recorded as its text. */
const parsedBody = (body: unknown): unknown => {
	if (body === undefined) return null;
	try { return JSON.parse(String(body)); } catch { return String(body); }
};
/** Records every call the client makes, the token mint included, and answers from the given script. */
function wire(answer: (url: string, init: RequestInit) => Response): { readonly calls: readonly WireCall[] } {
	const calls: WireCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ method: init?.method ?? "GET", path: new URL(url).pathname, auth: headers["Authorization"] ?? null,
			body: parsedBody(init?.body) });
		return answer(url, init ?? {});
	}) as typeof fetch;
	return { calls };
}
const tokenAnswer = { access_token: "recorded-token", expires_in: 300 };
const verifyAnswer = (status: string) => (url: string) => url.includes("/v1/oauth2/token")
	? Response.json(tokenAnswer) : Response.json({ verification_status: status });

test("the signed route verifies the signature before the re-read and applies on SUCCESS", async () => {
	const { f, jobId } = await capturingFixture();
	try {
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		const response = await delivered(f.ports, captureEnvelope("WH-P1-1"));
		assert.equal(response.status, 202);
		assert.deepEqual(f.calls, ["verify", "read"]);
		const held = await f.store.readJob(jobId);
		assert.equal(held?.state.status, "IN_PROGRESS");
		assert.deepEqual(recordedOutcome(f.store, "WH-P1-1"), "applied");
		if (held?.state.status !== "IN_PROGRESS") throw new Error("No held escrow");
		assert.deepEqual(held.state.escrow.book, [{ kind: "HELD", cents: 42000, at: now }]);
	} finally { f.store.close(); }
});

test("a verification FAILURE is refused before the re-read and applies nothing", async () => {
	const { f, jobId } = await capturingFixture();
	try {
		// The re-read is registered to prove a refusal never consults it, and the snapshot proves the
		// refused delivery moved no job state and wrote no outbox row.
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		const before = JSON.stringify(await f.store.readJob(jobId));
		const outboxBefore = outboxRows(f.store);
		f.verdicts.push({ kind: "REFUSED", reason: "VERIFICATION_FAILURE" });
		const response = await delivered(f.ports, captureEnvelope("WH-P1-2"));
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { received: false });
		assert.deepEqual(f.calls, ["verify"]);
		assert.equal(JSON.stringify(await f.store.readJob(jobId)), before);
		assert.equal(outboxRows(f.store), outboxBefore);
		assert.equal(recordedOutcome(f.store, "WH-P1-2"), "refused, VERIFICATION_FAILURE");
	} finally { f.store.close(); }
});

test("an unsigned delivery is refused with its reason code and applies nothing", async () => {
	const { f, jobId } = await capturingFixture();
	try {
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		const before = JSON.stringify(await f.store.readJob(jobId));
		f.verdicts.push({ kind: "REFUSED", reason: "UNSIGNED_DELIVERY" });
		const response = await delivered(f.ports, captureEnvelope("WH-P1-3"));
		assert.equal(response.status, 400);
		assert.deepEqual(f.calls, ["verify"]);
		assert.equal(JSON.stringify(await f.store.readJob(jobId)), before);
		assert.equal(recordedOutcome(f.store, "WH-P1-3"), "refused, UNSIGNED_DELIVERY");
	} finally { f.store.close(); }
});

test("a delivery whose verification inputs PayPal rejects is refused terminally at the route", async () => {
	const { f, jobId } = await capturingFixture();
	try {
		// The verdict PayPal's own 4xx produces: the route answers the same 400 a FAILURE gets, and the
		// reason code, not the HTTP status, is what distinguishes the two refusals in the row and log.
		f.verdicts.push({ kind: "REFUSED", reason: "VERIFICATION_INPUT_REJECTED", detail: "PayPal answered HTTP 400." });
		const before = JSON.stringify(await f.store.readJob(jobId));
		const response = await delivered(f.ports, captureEnvelope("WH-P1-3b"));
		assert.equal(response.status, 400);
		assert.deepEqual(f.calls, ["verify"]);
		assert.equal(JSON.stringify(await f.store.readJob(jobId)), before);
		assert.equal(recordedOutcome(f.store, "WH-P1-3b"), "refused, VERIFICATION_INPUT_REJECTED");
	} finally { f.store.close(); }
});

test("a verification outage answers 5xx, applies nothing, and a verified redelivery applies once", async () => {
	const { f, jobId } = await capturingFixture();
	try {
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		const before = JSON.stringify(await f.store.readJob(jobId));
		f.verdicts.push({ kind: "OUTAGE" });
		const outage = await delivered(f.ports, captureEnvelope("WH-P1-4"));
		assert.equal(outage.status, 503);
		assert.deepEqual(await outage.json(), { received: false });
		assert.deepEqual(f.calls, ["verify"]);
		assert.equal(JSON.stringify(await f.store.readJob(jobId)), before);
		assert.equal(recordedOutcome(f.store, "WH-P1-4"), "outage, VERIFICATION_UNAVAILABLE");
		// PayPal retries the same delivery id: this time the verdict is verified, and the fact applies
		// exactly once. A third delivery of the same fact under a new id is the familiar no-op.
		const retry = await delivered(f.ports, captureEnvelope("WH-P1-4"));
		assert.equal(retry.status, 202);
		assert.equal(recordedOutcome(f.store, "WH-P1-4"), "applied");
		const held = await f.store.readJob(jobId);
		assert.equal(held?.state.status, "IN_PROGRESS");
		const settled = JSON.stringify(held);
		const again = await delivered(f.ports, captureEnvelope("WH-P1-5"));
		assert.equal(again.status, 202);
		assert.equal(recordedOutcome(f.store, "WH-P1-5"), "no-op, job already IN_PROGRESS");
		assert.equal(JSON.stringify(await f.store.readJob(jobId)), settled);
	} finally { f.store.close(); }
});

test("the dev replay route skips verification; the signed route never does", async () => {
	const { f, jobId } = await capturingFixture();
	try {
		f.read(f.capture.captureId, { kind: "SETTLED", observation: { kind: "CAPTURE_COMPLETED", capture: f.capture } });
		// The dev-only replay delivers an unsigned envelope without a verify call, and applies as before.
		const replay = await ingestPayPalWebhook(f.ports,
			new Request("http://localhost:4310/api/dev/paypal/webhook", { method: "POST", body: captureEnvelope("WH-P1-6") }), true);
		assert.equal(replay.status, 202);
		assert.deepEqual(f.calls, ["read"]);
		assert.equal((await f.store.readJob(jobId))?.state.status, "IN_PROGRESS");
		// The signed route verifies in dev mode too: an unsigned post to it is refused, and nothing moves.
		const held = JSON.stringify(await f.store.readJob(jobId));
		f.verdicts.push({ kind: "REFUSED", reason: "UNSIGNED_DELIVERY" });
		const signed = await delivered(f.ports, captureEnvelope("WH-P1-7"));
		assert.equal(signed.status, 400);
		assert.equal(JSON.stringify(await f.store.readJob(jobId)), held);
	} finally { f.store.close(); }
});

test("the verify call carries the five headers, the configured webhook id, and the event, on the cached token", async () => {
	const original = globalThis.fetch;
	const answer = wire(url => url.includes("/v1/oauth2/token") ? Response.json(tokenAnswer)
		: Response.json({ verification_status: "SUCCESS" }));
	try {
		const paypal = createPayPal(configuredPayPal);
		const event = captureEnvelope("WH-P1-8");
		assert.deepEqual(await paypal.verifyWebhookDelivery(event, new Headers(transmission)), { kind: "VERIFIED" });
		const verifyCall = answer.calls.filter(call => call.path === "/v1/notifications/verify-webhook-signature");
		assert.equal(verifyCall.length, 1);
		assert.equal(verifyCall[0]?.method, "POST");
		assert.equal(verifyCall[0]?.auth, "Bearer recorded-token");
		assert.deepEqual(verifyCall[0]?.body, { auth_algo: "SHA256withRSA", cert_url: transmission["paypal-cert-url"],
			transmission_id: "TR-4GLX513", transmission_sig: "recorded-signature-bytes", transmission_time: "2026-10-06T12:00:00Z",
			webhook_id: "WH-CONFIGURED-ID", webhook_event: JSON.parse(event) });
		// A delivery signed under any other webhook id answers FAILURE to ours; ours is the one sent.
		// The second delivery mints no second token: the cached one still carries it.
		assert.deepEqual(await paypal.verifyWebhookDelivery(captureEnvelope("WH-P1-9"), new Headers(transmission)), { kind: "VERIFIED" });
		assert.equal(answer.calls.filter(call => call.path === "/v1/oauth2/token").length, 1);
		assert.equal(answer.calls.filter(call => call.path === "/v1/notifications/verify-webhook-signature").length, 2);
	} finally { globalThis.fetch = original; }
});

test("a delivery missing a transmission header is refused before any network call", async () => {
	const original = globalThis.fetch;
	const answer = wire(() => Response.json({ verification_status: "SUCCESS" }));
	try {
		const paypal = createPayPal(configuredPayPal);
		for (const missing of Object.keys(transmission)) {
			const headers = new Headers(transmission);
			headers.delete(missing);
			assert.deepEqual(await paypal.verifyWebhookDelivery(captureEnvelope("WH-P1-10"), headers),
				{ kind: "REFUSED", reason: "UNSIGNED_DELIVERY" });
		}
		assert.equal(answer.calls.length, 0);
	} finally { globalThis.fetch = original; }
});

test("a verification answer that is not SUCCESS is refused as a verification failure", async () => {
	const original = globalThis.fetch;
	const answer = wire(verifyAnswer("FAILURE"));
	try {
		const paypal = createPayPal(configuredPayPal);
		// A delivery signed under a webhook id that is not ours gets exactly this answer.
		assert.deepEqual(await paypal.verifyWebhookDelivery(captureEnvelope("WH-P1-11"), new Headers(transmission)),
			{ kind: "REFUSED", reason: "VERIFICATION_FAILURE", detail: "PayPal answered verification_status FAILURE." });
		assert.equal(answer.calls.filter(call => call.path === "/v1/notifications/verify-webhook-signature").length, 1);
	} finally { globalThis.fetch = original; }
});

test("a network error, a 5xx, a timeout, an unreadable answer, a 401, and a 429 are outages", async () => {
	const original = globalThis.fetch;
	try {
		const paypal = createPayPal(configuredPayPal);
		const faults: readonly [string, (init: RequestInit) => Response | Promise<Response>, string][] = [
			["connect ECONNREFUSED", () => { throw new Error("connect ECONNREFUSED"); }, "PayPal did not answer."],
			["timeout", () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, "The verify call timed out."],
			["5xx", () => Response.json({ name: "SERVICE_UNAVAILABLE" }, { status: 503 }), "PayPal answered HTTP 503."],
			["unreadable", () => Response.json({ error: "not the verification answer" }), "PayPal's answer named no verification status."],
			["401", () => Response.json({ error: "invalid_token" }, { status: 401 }), "PayPal answered HTTP 401."],
			["429", () => Response.json({ name: "RATE_LIMITED" }, { status: 429 }), "PayPal answered HTTP 429."],
		];
		for (const [name, respond, detail] of faults) {
			// The token endpoint answers normally in every fault: only the verify call itself fails.
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
				String(input).includes("/v1/oauth2/token") ? Response.json(tokenAnswer) : respond(init ?? {})) as typeof fetch;
			assert.deepEqual(await paypal.verifyWebhookDelivery(captureEnvelope("WH-P1-12"), new Headers(transmission)),
				{ kind: "OUTAGE", detail }, name);
		}
	} finally { globalThis.fetch = original; }
});

test("a 4xx that is neither a token nor a rate-limit answer is refused terminally, not an outage", async () => {
	const original = globalThis.fetch;
	try {
		const paypal = createPayPal(configuredPayPal);
		for (const status of [400, 403]) {
			// PayPal read the verification request itself and rejected its inputs (a malformed cert url
			// or transmission id): no retry of these bytes verifies, so the delivery is refused.
			globalThis.fetch = (async (input: string | URL | Request) =>
				String(input).includes("/v1/oauth2/token") ? Response.json(tokenAnswer)
					: Response.json({ name: "INVALID_REQUEST", message: "cert_url is malformed" }, { status })) as typeof fetch;
			assert.deepEqual(await paypal.verifyWebhookDelivery(captureEnvelope("WH-P1-13"), new Headers(transmission)),
				{ kind: "REFUSED", reason: "VERIFICATION_INPUT_REJECTED", detail: `PayPal answered HTTP ${status}.` }, String(status));
		}
	} finally { globalThis.fetch = original; }
});
