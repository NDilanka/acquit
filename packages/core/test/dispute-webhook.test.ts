// The buyer dispute webhook through the route, on the dev replay path. A DISPUTE envelope names a capture, the route
// re-reads the dispute from PayPal (the harness fake answers from a map the test fills), and the fact applies to the job
// that holds the capture. Each delivery's outcome is recorded on its webhook_events row.

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CaptureId, JobId } from "../src/ids.ts";
import { instant } from "../src/ids.ts";
import type { JobRow } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { DisputeId } from "../src/paypal.ts";
import { drive, harness } from "./scenario-harness.ts";

const disputeDelivery = (eventId: string, eventType: string, disputeId: string, status: string): Request =>
	new Request("http://acquit.test/paypal/webhook", { method: "POST",
		body: JSON.stringify({ id: eventId, event_type: eventType, resource_type: "dispute", resource: { dispute_id: disputeId, status } }) });

const captureOf = (row: JobRow): CaptureId => {
	if (row.state.status === "IN_PROGRESS" || row.state.status === "VERIFIED") return row.state.escrow.capture.captureId;
	throw new Error(`no capture on a ${row.state.status} job`);
};

const outcomeOf = (db: DatabaseSync, id: string): string =>
	String((db.prepare("SELECT outcome FROM webhook_events WHERE id = ?").get(id) as { outcome: string } | undefined)?.outcome);

test("a DISPUTE envelope through the dev replay route applies to the job that holds its capture, and the delivery is recorded as applied", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "hidden-test-fail");
		const jobId = run.jobId as JobId;
		const before = await h.store.readJob(jobId);
		if (before === null) throw new Error("the job is missing");
		h.paypalDisputes.set("PP-D-9", { kind: "DISPUTE", disputeId: "PP-D-9" as DisputeId, captureId: captureOf(before), status: "OPEN",
			reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount: usd("400.00"), openedAt: instant("2026-10-06T12:30:00Z") });
		const response = await h.acquit.handlePayPalWebhookDev(disputeDelivery("WH-DISPUTE-1", "CUSTOMER.DISPUTE.CREATED", "PP-D-9", "OPEN"));
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { received: true });
		const after = await h.store.readJob(jobId);
		assert.deepEqual(after?.providerDispute, { id: "PP-D-9", status: "OPEN", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
			amount: usd("400.00"), openedAt: instant("2026-10-06T12:30:00Z") });
		assert.equal(after?.version, (before.version + 1));
		// The dispute is not simulated, so PayPal was asked for it, and the delivery reads back as applied on the dev path.
		assert.deepEqual(h.disputeReads, ["PP-D-9"]);
		assert.equal(outcomeOf(h.store.db, "WH-DISPUTE-1"), "applied");
	} finally { await h.dispose(); }
});

test("the same CREATED delivered again under a new event id is a replay no-op that changes nothing", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "hidden-test-fail");
		const jobId = run.jobId as JobId;
		const before = await h.store.readJob(jobId);
		if (before === null) throw new Error("the job is missing");
		h.paypalDisputes.set("PP-D-9", { kind: "DISPUTE", disputeId: "PP-D-9" as DisputeId, captureId: captureOf(before), status: "OPEN",
			reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount: usd("400.00"), openedAt: instant("2026-10-06T12:30:00Z") });
		await h.acquit.handlePayPalWebhookDev(disputeDelivery("WH-DISPUTE-1", "CUSTOMER.DISPUTE.CREATED", "PP-D-9", "OPEN"));
		const applied = await h.store.readJob(jobId);
		const replay = await h.acquit.handlePayPalWebhookDev(disputeDelivery("WH-DISPUTE-2", "CUSTOMER.DISPUTE.CREATED", "PP-D-9", "OPEN"));
		assert.equal(replay.status, 202);
		assert.equal(outcomeOf(h.store.db, "WH-DISPUTE-2"), "no-op, job already IN_PROGRESS");
		const after = await h.store.readJob(jobId);
		assert.equal(after?.version, applied?.version);
		assert.deepEqual(after?.providerDispute, applied?.providerDispute);
	} finally { await h.dispose(); }
});

test("a dispute naming a capture no job holds is a no-op with its outcome recorded, and no job changes", async () => {
	const h = await harness();
	try {
		const run = await drive(h, "hidden-test-fail");
		const jobId = run.jobId as JobId;
		const before = await h.store.readJob(jobId);
		h.paypalDisputes.set("PP-D-404", { kind: "DISPUTE", disputeId: "PP-D-404" as DisputeId, captureId: "CAPTURE-NOBODY-HOLDS" as CaptureId, status: "OPEN",
			reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", amount: usd("400.00"), openedAt: instant("2026-10-06T12:30:00Z") });
		const response = await h.acquit.handlePayPalWebhookDev(disputeDelivery("WH-DISPUTE-404", "CUSTOMER.DISPUTE.CREATED", "PP-D-404", "OPEN"));
		assert.equal(response.status, 202);
		assert.equal(outcomeOf(h.store.db, "WH-DISPUTE-404"), "no-op, no job holds this resource");
		const after = await h.store.readJob(jobId);
		assert.equal(after?.version, before?.version);
		assert.equal(after?.providerDispute, undefined);
	} finally { await h.dispose(); }
});
