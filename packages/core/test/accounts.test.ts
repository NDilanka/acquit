// Lasting accounts at the store: the migration that lets a visitor row have no expiry, and the recovery token that
// restores an account. Only the token's digest is stored, a new token ends the old one, and no token reaches a row
// that is not an active lasting account's own client.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { accountForRecoveryToken, makeRecoveryToken, recoveryLinkMade } from "../src/accounts.ts";
import { instant } from "../src/ids.ts";
import type { MerchantId, VisitorId } from "../src/ids.ts";
import { SqliteStore } from "../src/store.ts";
import { insertVisitor, newVisitorId, readVisitor, reserveVisitor } from "../src/visitors.ts";

const now = instant("2026-10-24T09:00:00.000Z");
const merchant = "sandbox-seller" as MerchantId;

test("a database from before lasting accounts keeps every visitor row and its expiry, and takes rows with none", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-accounts-migration-"));
	const path = join(root, "acquit.db");
	try {
		const old = new DatabaseSync(path);
		old.exec(`CREATE TABLE visitors (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
			ip_key TEXT NOT NULL, client_handle TEXT NOT NULL, operator_handle TEXT NOT NULL, repository TEXT,
			repository_id INTEGER, state TEXT NOT NULL DEFAULT 'ACTIVE');
			CREATE INDEX visitors_expiry ON visitors(expires_at);`);
		old.prepare("INSERT INTO visitors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("v_00000000000a", "2026-10-01T00:00:00.000Z",
			"2026-10-02T00:00:00.000Z", "ip-old", "guest-00000000000a-client", "guest-00000000000a-ops", "acquit-forks/demo-00000000000a", 77, "SWEPT");
		old.close();
		const store = new SqliteStore(path);
		try {
			assert.deepEqual(readVisitor(store.db, "v_00000000000a" as VisitorId), { id: "v_00000000000a", createdAt: "2026-10-01T00:00:00.000Z",
				expiresAt: "2026-10-02T00:00:00.000Z", displayName: null, ipKey: "ip-old", clientHandle: "guest-00000000000a-client",
				operatorHandle: "guest-00000000000a-ops", repository: "acquit-forks/demo-00000000000a", repositoryId: 77, state: "SWEPT" });
			const columns = store.db.prepare("SELECT name, \"notnull\" AS required FROM pragma_table_info('visitors')").all()
				.map(row => `${String(row.name)}:${Number(row.required)}`);
			assert.deepEqual(columns, ["id:0", "created_at:1", "expires_at:0", "ip_key:1", "client_handle:1", "operator_handle:1", "repository:0",
				"repository_id:0", "state:1", "display_name:0", "recovery_digest:0", "recovery_made_at:0"]);
			const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'visitors' AND sql IS NOT NULL ORDER BY name").all()
				.map(row => String(row.name));
			assert.deepEqual(indexes, ["visitors_expiry", "visitors_recovery"]);
			const account = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-new", repository: null, merchant, now });
			assert.equal(readVisitor(store.db, account.id)?.expiresAt, null);
		} finally { store.close(); }
		// A second open finds the new shape and changes nothing.
		const again = new SqliteStore(path);
		try {
			assert.equal((again.db.prepare("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n, 2);
		} finally { again.close(); }
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a recovery token is stored only as its digest and opens its own account", () => {
	const store = new SqliteStore(":memory:");
	try {
		const account = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now });
		assert.equal(recoveryLinkMade(store.db, account.id), false);
		const token = makeRecoveryToken(store.db, account.id, now);
		assert.equal(typeof token, "string");
		assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);
		const stored = { ...store.db.prepare("SELECT recovery_digest, recovery_made_at FROM visitors WHERE id = ?").get(account.id) };
		assert.deepEqual(stored, { recovery_digest: createHash("sha256").update(token ?? "").digest("hex"), recovery_made_at: "2026-10-24T09:00:00.000Z" });
		assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM visitors").all()).includes(token ?? "-"), false);
		assert.equal(recoveryLinkMade(store.db, account.id), true);
		assert.equal(accountForRecoveryToken(store.db, token ?? "")?.id, account.id);
	} finally { store.close(); }
});

test("a new token ends the old one", () => {
	const store = new SqliteStore(":memory:");
	try {
		const account = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now });
		const first = makeRecoveryToken(store.db, account.id, now) ?? "";
		const second = makeRecoveryToken(store.db, account.id, now) ?? "";
		assert.notEqual(first, second);
		assert.equal(accountForRecoveryToken(store.db, first), null);
		assert.equal(accountForRecoveryToken(store.db, second)?.id, account.id);
	} finally { store.close(); }
});

test("a malformed, unknown, or foreign token opens nothing", () => {
	const store = new SqliteStore(":memory:");
	try {
		insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now });
		for (const bad of ["", "short", "A".repeat(43), "A".repeat(44), "../../etc/passwd", "A".repeat(42) + "="]) {
			assert.equal(accountForRecoveryToken(store.db, bad), null, bad);
		}
	} finally { store.close(); }
});

test("only an active lasting account makes a token, and no token reaches a scenario visitor, a seeded handle, or the platform", () => {
	const store = new SqliteStore(":memory:");
	try {
		const account = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now });
		const scenario = reserveVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: null, merchant, now, scenarioOf: account.id });
		if (scenario.kind !== "RESERVED") throw new Error("the scenario visitor was refused");
		assert.equal(makeRecoveryToken(store.db, scenario.visitor.id, now), null, "a scenario visitor has no recovery link");
		assert.equal(makeRecoveryToken(store.db, "v_ffffffffffff" as VisitorId, now), null);
		// A row whose digest is planted by hand still opens nothing unless it is an active lasting account's own client.
		const plant = (id: string, client: string, expiresAt: string | null, state: string): string => {
			const token = "B".repeat(42) + id.slice(-1);
			store.db.prepare(`INSERT INTO visitors (id, created_at, expires_at, ip_key, client_handle, operator_handle, state, recovery_digest)
				VALUES (?, ?, ?, 'ip-x', ?, ?, ?, ?)`).run(id, now, expiresAt, client, `${client}-ops`, state, createHash("sha256").update(token).digest("hex"));
			return token;
		};
		assert.equal(accountForRecoveryToken(store.db, plant("v_00000000000a", "platform", null, "ACTIVE")), null, "the platform principal");
		assert.equal(accountForRecoveryToken(store.db, plant("v_00000000000b", "maya-client", null, "ACTIVE")), null, "a seeded client");
		assert.equal(accountForRecoveryToken(store.db, plant("v_00000000000c", account.operatorHandle, null, "ACTIVE")), null, "another visitor's operator");
		assert.equal(accountForRecoveryToken(store.db, plant("v_00000000000d", account.clientHandle, null, "ACTIVE")), null, "another visitor's client");
		store.db.prepare("INSERT INTO principals VALUES (?, 'CLIENT', ?)").run("lone-client", "v_00000000000e");
		assert.equal(accountForRecoveryToken(store.db, plant("v_00000000000e", "lone-client", "2026-10-25T09:00:00.000Z", "ACTIVE")), null, "an expiring visitor");
		store.db.prepare("INSERT INTO principals VALUES (?, 'CLIENT', ?)").run("swept-client", "v_00000000000f");
		assert.equal(accountForRecoveryToken(store.db, plant("v_00000000000f", "swept-client", null, "SWEPT")), null, "a swept visitor");
	} finally { store.close(); }
});
