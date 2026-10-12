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
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'SEED', 1, ?)").run("rcpt_house-seed-001", null, "house-tsfix", 1, "2026-10-11T00:00:00Z");
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'SEED', 0, NULL)").run("rcpt_house-seed-002", null, "house-tsfix", 0, null);
		store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'JOB', 1, ?)").run("rcpt_devonjob", "job_paidone", "devon-ops", 1, now);
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

		const devon = operatorReceipts(store.db, "devon-ops", "maya-client/invoice-app");
		assert.equal(devon.length, 1);
		assert.equal(devon[0]?.id, "rcpt_devonjob");
		assert.equal(devon[0]?.source, "JOB");
		assert.equal(devon[0]?.paid, 360_00);
		assert.equal(devon[0]?.repository, "maya-client/invoice-app");

		const house = operatorReceipts(store.db, "house-tsfix", "maya-client/invoice-app");
		// The paid job's receipt row is SEED in the table (the F6 backfill marks it so), so the read
		// labels it seeded exactly where the book marks it.
		assert.deepEqual(house.map(r => [r.id, r.source, r.jobId, r.passedVerifiedCi]), [
			["rcpt_housejob", "SEED", "job_paidtwo", true],
			["rcpt_house-seed-001", "SEED", null, true],
			["rcpt_house-seed-002", "SEED", null, false],
		]);
	} finally { store.close(); }
});
