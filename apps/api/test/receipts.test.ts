// The receipts route's read: a job receipt joins the receipts table only to carry its source, and
// the deployment's seeded history rows (no job behind them) appear as SEED rows of their own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteStore } from "../../../packages/core/src/store.ts";
import { operatorReceipts } from "../src/receipts.ts";

const now = "2026-10-12T00:00:00Z";

test("the operator's receipts read marks job rows JOB and seeded rows SEED", () => {
	const store = new SqliteStore(":memory:");
	try {
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'SEED', ?, ?)").run("rcpt_house-seed-001", null, "house-tsfix", 1, "2026-10-11T00:00:00Z");
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'SEED', ?, ?)").run("rcpt_house-seed-002", null, "house-tsfix", 0, null);
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'JOB', ?, ?)").run("rcpt_devonjob", "job_paidone", "devon-ops", 1, now);
		// The F6 backfill marked every pre-existing PAID job's receipt row SEED, so a job receipt can
		// be seeded history: the read labels it exactly as the book does.
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'SEED', ?, ?)").run("rcpt_housejob", "job_paidtwo", "house-tsfix", 1, now);
		const receipt = { id: "rcpt_devonjob", jobId: "job_paidone", operator: "devon-ops", agent: "ts-bugfixer",
			pullRequest: 1, mergeCommit: "a".repeat(40), frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
			attemptsUsed: 1, paid: 360_00, releasedAt: now };
		const job = { contract: { definitionOfDone: { issue: { repository: "maya-client/invoice-app" } } },
			state: { status: "PAID", payee: { operator: "devon-ops" }, receipt } };
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_paidone", JSON.stringify(job));
		const other = { contract: { definitionOfDone: { issue: { repository: "maya-client/invoice-app" } } },
			state: { status: "PAID", payee: { operator: "house-tsfix" },
				receipt: { ...receipt, id: "rcpt_housejob", jobId: "job_paidtwo", releasedAt: now } } };
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_paidtwo", JSON.stringify(other));

		const devon = operatorReceipts(store.db, "devon-ops", "maya-client/invoice-app", () => null);
		assert.equal(devon.length, 1);
		assert.equal(devon[0]?.id, "rcpt_devonjob");
		assert.equal(devon[0]?.source, "JOB");
		assert.equal(devon[0]?.paid, 360_00);
		assert.equal(devon[0]?.repository, "maya-client/invoice-app");

		const house = operatorReceipts(store.db, "house-tsfix", "maya-client/invoice-app", () => null);
		// The paid job's receipt row is SEED in the table (the F6 backfill marks it so), so the read
		// labels it seeded exactly where the book marks it.
		assert.deepEqual(house.map(r => [r.id, r.source, r.jobId, r.passedVerifiedCi]), [
			["rcpt_housejob", "SEED", "job_paidtwo", true],
			["rcpt_house-seed-001", "SEED", null, true],
			["rcpt_house-seed-002", "SEED", null, false],
		]);
	} finally { store.close(); }
});

test("a job receipt carries the fee and the gross its book held, for the receipt card", () => {
	const store = new SqliteStore(":memory:");
	try {
		const receipt = { id: "rcpt_devonjob", jobId: "job_paidone", operator: "devon-ops", agent: "ts-bugfixer",
			pullRequest: 1, mergeCommit: "a".repeat(40), frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 },
			attemptsUsed: 1, paid: 360_00, releasedAt: now };
		const job = { contract: { definitionOfDone: { issue: { repository: "maya-client/invoice-app" } } },
			state: { status: "PAID", payee: { operator: "devon-ops" }, receipt,
				book: [{ kind: "HELD", cents: 420_00, at: now }, { kind: "RELEASED", cents: 360_00, at: now },
					{ kind: "FEE", cents: 6_000, processor: 1_515, acquit: 4_485, at: now }] } };
		store.db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run("job_paidone", JSON.stringify(job));
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'JOB', ?, ?)").run("rcpt_devonjob", "job_paidone", "devon-ops", 1, now);
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'SEED', ?, ?)").run("rcpt_house-seed-001", null, "devon-ops", 1, now);

		const devon = operatorReceipts(store.db, "devon-ops", "maya-client/invoice-app", () => null);
		const jobRow = devon.find(row => row.source === "JOB");
		assert.ok(jobRow, "the job receipt row is present");
		assert.equal(jobRow.fee, 6_000);
		assert.equal(jobRow.grossPaid, 420_00);
		assert.equal(jobRow.result, "VERIFIED");
		const seeded = devon.find(row => row.source === "SEED");
		assert.ok(seeded, "the seeded row is present");
		assert.equal(seeded.fee, null);
		assert.equal(seeded.grossPaid, null);
	} finally { store.close(); }
});
