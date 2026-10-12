// The payouts route's read: one row per release the operator was paid, carrying the referenced
// payout item the capture paid through. A client's money never appears in an operator's list.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import { operatorPayouts } from "../src/payouts.ts";

const now = "2026-10-12T00:00:00Z";

function paidJob(payee: string, repository: string, overrides: Record<string, unknown> = {}): object {
	return { contract: { definitionOfDone: { issue: { repository } } },
		state: { status: "PAID", payee: { operator: payee },
			release: { payoutItemId: "8XY48956W6967412H", captureId: "9CA12345A6967412H", paid: 360_00, at: now },
			releaseAuthority: "CLIENT_APPROVAL", ...overrides } };
}

test("the operator's payouts list carries each paid job's payout item and amount", () => {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_paidone", JSON.stringify(paidJob("devon-ops", "maya-client/invoice-app")));
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_paidtwo", JSON.stringify(paidJob("house-tsfix", "maya-client/invoice-app")));

		const devon = operatorPayouts(store.db, "devon-ops", "maya-client/invoice-app");
		assert.equal(devon.length, 1);
		assert.equal(devon[0]?.jobId, "job_paidone");
		assert.equal(devon[0]?.payoutItemId, "8XY48956W6967412H");
		assert.equal(devon[0]?.paid, 360_00);
		assert.equal(devon[0]?.captureId, "9CA12345A6967412H");
		assert.equal(devon[0]?.releasedAt, now);
		assert.equal(devon[0]?.repository, "maya-client/invoice-app");
	} finally { store.close(); }
});

test("an operator with no paid jobs reads an empty payout list", () => {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_paidone", JSON.stringify(paidJob("devon-ops", "maya-client/invoice-app")));
		assert.deepEqual(operatorPayouts(store.db, "house-tsfix", "maya-client/invoice-app"), []);
	} finally { store.close(); }
});

test("a job's payout appears only in the payee operator's list", () => {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_paidone", JSON.stringify(paidJob("devon-ops", "maya-client/invoice-app")));
		// The leak check: another operator's list never carries the job, and the client's own reads
		// are refused by the route before this read runs.
		assert.deepEqual(operatorPayouts(store.db, "house-tsfix", "maya-client/invoice-app"), []);
		assert.deepEqual(operatorPayouts(store.db, "maya-client", "maya-client/invoice-app"), []);
	} finally { store.close(); }
});

test("a HELD or refunded job carries no payout row", () => {
	const store = new SqliteStore(":memory:");
	try {
		const held = { contract: { definitionOfDone: { issue: { repository: "maya-client/invoice-app" } } },
			state: { status: "IN_PROGRESS", payee: { operator: "devon-ops" }, escrow: { phase: "HELD", held: 420_00 } } };
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_held", JSON.stringify(held));
		assert.deepEqual(operatorPayouts(store.db, "devon-ops", "maya-client/invoice-app"), []);
	} finally { store.close(); }
});
