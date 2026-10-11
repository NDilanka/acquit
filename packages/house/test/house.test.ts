// The House's own facts: its bid-row line comes from receipt rows, and its seed never borrows
// another operator's payee. Everything here runs without Docker, a browser, or a model call.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { houseLine } from "../../core/src/job.ts";

const root = resolve(import.meta.dirname, "../../..");
const ctl = join(root, "packages/ctl/src/main.ts");

test("the House label counts a receipts table of 41 rows with 39 paid", () => {
	assert.equal(houseLine({ total: 41, paid: 39 }), "41 fixes, 39 passed verified CI");
});

test("the House label counts a new real receipt together with the seeded rows", () => {
	assert.equal(houseLine({ total: 42, paid: 40 }), "42 fixes, 40 passed verified CI");
});

test("seed run without the House merchant id fails and writes no House operator with Devon's merchant", () => {
	const database = join(mkdtempSync(join(tmpdir(), "acquit-house-seed-")), "acquit.db");
	try {
		const run = spawnSync(process.execPath, [ctl, "seed-db", "--yes"],
			{ encoding: "utf8", timeout: 120_000, env: { ...process.env, ACQUIT_DEV: "1", DATABASE_PATH: database, OPERATOR_HOUSE_MERCHANT_ID: "" } });
		assert.notEqual(run.status, 0, "the seed must fail without OPERATOR_HOUSE_MERCHANT_ID");
		assert.match(`${run.stdout}\n${run.stderr}`, /OPERATOR_HOUSE_MERCHANT_ID/);
		assert.ok(!existsSync(database) || !houseOperator(database), "a failed seed writes no house-tsfix operator");
		assert.ok(!existsSync(database) || !houseOperatorWithDevonMerchant(database), "the House must never carry Devon's merchant");
	} finally { rmSync(join(database, ".."), { recursive: true, force: true }); }
});

test("seed writes the configured House merchant, different from Devon's, with 41 seeded receipts", () => {
	const database = join(mkdtempSync(join(tmpdir(), "acquit-house-seed-")), "acquit.db");
	// A stand-in value passed through the child environment, compared in process here and never printed.
	const configured = "HOUSESEEDMERCHANT";
	try {
		const run = spawnSync(process.execPath, [ctl, "seed-db", "--yes"],
			{ encoding: "utf8", timeout: 120_000, env: { ...process.env, ACQUIT_DEV: "1", DATABASE_PATH: database, OPERATOR_HOUSE_MERCHANT_ID: configured } });
		assert.equal(run.status, 0, `the seed with the House merchant id set must pass: ${run.stderr.slice(0, 300)}`);
		const db = new DatabaseSync(database, { readOnly: true });
		try {
			const house = merchantOf(db, "house-tsfix");
			const devon = merchantOf(db, "devon-ops");
			assert.equal(house === configured, true, "the seeded House merchant equals the configured value");
			assert.equal(house !== null && house !== devon, true, "the House merchant differs from Devon's");
			const rows = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(paid), 0) AS paid, COALESCE(GROUP_CONCAT(DISTINCT source), '') AS sources FROM receipts WHERE operator = ?").get("house-tsfix");
			assert.equal(Number(rows?.n ?? 0), 41, "the seed writes 41 House receipt rows");
			assert.equal(Number(rows?.paid ?? 0), 39, "39 of the seeded rows are paid");
			assert.equal(String(rows?.sources ?? ""), "SEED", "every seeded row is marked SEED");
		} finally { db.close(); }
	} finally { rmSync(join(database, ".."), { recursive: true, force: true }); }
});

function houseOperator(database: string): boolean {
	const db = new DatabaseSync(database, { readOnly: true });
	try { return db.prepare("SELECT 1 FROM operators WHERE id = ?").get("house-tsfix") !== undefined; }
	finally { db.close(); }
}

function houseOperatorWithDevonMerchant(database: string): boolean {
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		const row = db.prepare("SELECT json FROM operators WHERE id = ?").get("house-tsfix");
		const devon = merchantOf(db, "devon-ops");
		if (!row) return false;
		const merchant = JSON.parse(String(row.json))?.payouts?.merchant;
		return devon !== null && merchant === devon;
	} finally { db.close(); }
}

function merchantOf(db: DatabaseSync, operator: string): string | null {
	const row = db.prepare("SELECT json FROM operators WHERE id = ?").get(operator);
	if (!row) return null;
	const merchant = JSON.parse(String(row.json))?.payouts?.merchant;
	return typeof merchant === "string" ? merchant : null;
}
