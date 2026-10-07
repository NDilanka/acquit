// The API's own transactions. One unit of work per call, synchronous by contract: a promise would
// let COMMIT run before the work it names finished. No nesting, so a callback cannot open another
// unit of work under this one.

import type { DatabaseSync } from "node:sqlite";

/**
 * Runs `work` inside one BEGIN IMMEDIATE, so two requests cannot both read a row as unclaimed and
 * then both claim it. A failed BEGIN starts nothing, so it is rethrown without a ROLLBACK; a failure
 * after BEGIN rolls back before its error is rethrown. A rollback that cannot end the transaction is
 * retried and then surfaced: swallowing it would leave every later BEGIN on the connection refused.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
	if (db.isTransaction) throw new Error("transaction() entered while a transaction is already open");
	db.exec("BEGIN IMMEDIATE");
	let value: T;
	try {
		value = work();
		if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
			throw new Error("transaction() work must be synchronous, not a promise");
		}
		db.exec("COMMIT");
	} catch (error) {
		rollback(db);
		throw error;
	}
	return value;
}

/** Ends the failed unit of work before its error is rethrown. */
function rollback(db: DatabaseSync): void {
	let failure: unknown = null;
	for (let attempt = 0; attempt < 3 && db.isTransaction; attempt++) {
		try { db.exec("ROLLBACK"); return; }
		catch (error) { failure = error; }
	}
	if (db.isTransaction) throw failure ?? new Error("The transaction is still open after ROLLBACK");
}
