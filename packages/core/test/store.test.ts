// Opening a lane's database. The pre-envelope migration writes, so it runs under the lock guard: a
// second process writing the same file would otherwise fail the API's start with "database is locked".
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectJob } from "../src/job.ts";
import { openDatabase, SqliteStore } from "../src/store.ts";
import type { ClientId, JobId } from "../src/ids.ts";

/** A second process that holds the file's write lock for 600 ms, on a table that predates the envelope. */
const LOCK_HOLDER = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO webhook_events (id, body) VALUES (?, ?)").run("legacy", "raw");
process.stdout.write("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 600);`;

test("a lane opens through the pre-envelope migration while another writer holds the lock", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-store-"));
	const file = join(dir, "lane.db");
	const legacy = new DatabaseSync(file);
	legacy.exec("CREATE TABLE webhook_events (id TEXT PRIMARY KEY, body TEXT)");
	legacy.close();
	const holder = spawn(process.execPath, ["-e", LOCK_HOLDER, file], { stdio: ["ignore", "pipe", "inherit"] });
	try {
		await new Promise<void>((resolve, reject) => {
			holder.stdout.once("data", () => resolve());
			holder.once("exit", code => reject(new Error(`The lock holder exited with code ${code} before locking`)));
		});
		const db = openDatabase(file);
		try {
			assert.equal(Number(db.prepare("PRAGMA busy_timeout").get()?.timeout), 5000);
			const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('webhook_events')").all().map(row => String(row.name)));
			assert.equal(columns.has("body"), false);
			assert.equal(columns.has("outcome"), true);
		} finally { db.close(); }
	} finally {
		holder.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A raw PAID row as a lane stored it. `releaseAuthority` is whatever its bytes carry, or absent. */
function storedPaidRow(id: string, releaseAuthority?: unknown) {
	const at = "2026-10-06T12:00:00.000Z";
	return { id, version: 3, client: "maya-client", title: "stored paid row", openedAt: at,
		contract: { budget: 40000, deliveryEndsAt: "2026-10-13T12:00:00.000Z" },
		bids: [],
		state: { status: "PAID",
			payee: { bidId: "bid_store", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
			book: [],
			release: { payoutItemId: "ITEM", captureId: "CAPTURE", paid: 36000, at },
			merge: { phase: "PENDING" },
			receipt: { id: `rcpt_${id}`, jobId: id, operator: "devon-ops", agent: "ts-bugfixer", pullRequest: 13,
				mergeCommit: "a".repeat(40), frozen: { expected: 1, passed: 1 }, hidden: { expected: 1, passed: 1 },
				attemptsUsed: 1, paid: 36000, releasedAt: at },
			...(releaseAuthority === undefined ? {} : { releaseAuthority }) } };
}

test("a PAID row's release authority reads as one of the five, or null", async () => {
	const store = new SqliteStore(":memory:");
	const maya = { role: "CLIENT" as const, clientId: "maya-client" as ClientId };
	try {
		for (const [id, authority] of [["job_paid_missing", undefined], ["job_paid_unknown", "NOT_AN_AUTHORITY"], ["job_paid_authority", "REVIEW_SILENCE"]] as const) {
			const row = storedPaidRow(id, authority);
			store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(id, row.version, JSON.stringify(row), null);
		}
		// The bytes a lane stored before F4 named no authority at all.
		const missing = await store.readJob("job_paid_missing" as JobId);
		if (missing?.state.status !== "PAID") throw new Error("Missing the stored paid row");
		assert.equal(missing.state.releaseAuthority, null);
		assert.equal(projectJob(missing, maya, new Map()).releaseAuthority, null);
		// An authority outside the domain's five is not a stored fact: it reads as null too.
		const unknown = await store.readJob("job_paid_unknown" as JobId);
		if (unknown?.state.status !== "PAID") throw new Error("Missing the stored paid row");
		assert.equal(unknown.state.releaseAuthority, null);
		assert.equal(projectJob(unknown, maya, new Map()).releaseAuthority, null);
		// A known authority stays what the row recorded.
		const known = await store.readJob("job_paid_authority" as JobId);
		if (known?.state.status !== "PAID") throw new Error("Missing the stored paid row");
		assert.equal(known.state.releaseAuthority, "REVIEW_SILENCE");
		assert.equal(projectJob(known, maya, new Map()).releaseAuthority, "REVIEW_SILENCE");
	} finally { store.close(); }
});
