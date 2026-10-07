import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { transaction } from "../../../apps/api/src/transaction.ts";

const count = (db: DatabaseSync) => Number((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n);

test("a failing callback rolls back its writes, ends the transaction, and rethrows its error", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE t (x TEXT)");
	assert.throws(() => transaction(db, () => {
		db.prepare("INSERT INTO t VALUES (?)").run("rolled-back");
		throw new Error("work failed");
	}), (error: Error) => error.message === "work failed");
	assert.equal(db.isTransaction, false);
	assert.equal(count(db), 0);
	db.close();
});

test("a BEGIN the lock refuses runs no work and leaves the connection able to begin again", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-txn-"));
	const path = join(dir, "locked.db");
	const writer = new DatabaseSync(path);
	writer.exec("CREATE TABLE t (x TEXT)");
	const db = new DatabaseSync(path);
	try {
		writer.exec("BEGIN IMMEDIATE");
		let ran = false;
		assert.throws(() => transaction(db, () => { ran = true; return "never"; }), /database is locked/);
		assert.equal(ran, false);
		assert.equal(db.isTransaction, false);
		writer.exec("ROLLBACK");
		assert.equal(transaction(db, () => { db.prepare("INSERT INTO t VALUES (?)").run("after"); return "committed"; }), "committed");
		assert.equal(count(db), 1);
	} finally {
		writer.close();
		db.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("entering with a transaction already open is a clear error that leaves the outer one alone", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE t (x TEXT)");
	db.exec("BEGIN IMMEDIATE");
	db.prepare("INSERT INTO t VALUES (?)").run("outer");
	assert.throws(() => transaction(db, () => db.prepare("INSERT INTO t VALUES (?)").run("inner")),
		(error: Error) => /already open/.test(error.message));
	assert.equal(db.isTransaction, true);
	assert.equal(count(db), 1);
	db.exec("COMMIT");
	assert.equal(count(db), 1);
	db.close();
});

test("a callback that returns a promise is refused instead of committing before its work", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE t (x TEXT)");
	assert.throws(() => transaction(db, () => Promise.resolve("later")), /synchronous/);
	assert.equal(db.isTransaction, false);
	db.close();
});
