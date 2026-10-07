// Opening a lane's database. The pre-envelope migration writes, so it runs under the lock guard: a
// second process writing the same file would otherwise fail the API's start with "database is locked".
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/store.ts";

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
