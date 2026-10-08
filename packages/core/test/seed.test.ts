// A re-seed starts the deployment's day over. The caps read only committed reservations, so the rows
// a previous lane spent must go with the jobs, visitors, and principals the seed already wipes. A
// stale day would otherwise refuse a fresh visitor's first act.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeAcquit, createAcquit, createDemoVisitor } from "../src/acquit.ts";
import { instant } from "../src/ids.ts";
import type { MerchantId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { SqliteStore } from "../src/store.ts";
import { newVisitorId } from "../src/visitors.ts";
import { exampleContract } from "./hidden-fixture.ts";

const merchant = "sandbox-seller" as MerchantId;
const root = fileURLToPath(new URL("../../..", import.meta.url));
const seedScript = join(root, "scripts/seed.ts");

/** The real seed script, run the way the operator runs it, against this test's own database. */
function seed(databasePath: string): void {
	const child = spawnSync(process.execPath, [seedScript], { cwd: root, encoding: "utf8", timeout: 30_000,
		env: { ...process.env, DATABASE_PATH: databasePath, ACQUIT_DEV: "1", PAYPAL_CLIENT_ID: "test-client",
			PAYPAL_CLIENT_SECRET: "test-secret", OPERATOR_DEVON_MERCHANT_ID: merchant } });
	assert.equal(child.status, 0, child.stderr);
}

test("a re-seed forgets the reservations a previous day spent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-seed-"));
	const path = join(dir, "acquit.db");
	try {
		seed(path);
		// A previous lane's day: the deployment-wide visitor allowance is already spent.
		const at = instant(new Date().toISOString());
		const store = new SqliteStore(path);
		for (let index = 0; index < 50; index++) {
			store.db.prepare("INSERT INTO cap_reservations VALUES (?, ?, ?, ?, ?)").run("VISITOR", "ip-stale", `v_stale${index}`, 0, at);
		}
		store.close();
		seed(path);
		const after = new SqliteStore(path);
		const reservations = Number((after.db.prepare("SELECT COUNT(*) AS n FROM cap_reservations").get() as { n: number }).n);
		after.close();
		assert.equal(reservations, 0, "the seed leaves no reservation behind");
		// The fresh visitor's own reservation is the observable effect: with the stale day still there,
		// the deployment-wide cap refuses it before its row exists.
		const service = createAcquit({ databaseUrl: path, hiddenContract: exampleContract, demo: { merchant },
			paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
				webhookId: "", partnerMerchant: merchant, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
			verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
		const reader = new SqliteStore(path);
		try {
			const created = await createDemoVisitor(service, { id: newVisitorId(), ipKey: "ip-fresh", repository: null });
			assert.equal(created.kind, "CREATED");
			const reserved = Number((reader.db.prepare("SELECT COUNT(*) AS n FROM cap_reservations WHERE kind = 'VISITOR' AND scope = 'ip-fresh'").get() as { n: number }).n);
			assert.equal(reserved, 1);
		} finally { reader.close(); closeAcquit(service); }
	} finally { await rm(dir, { recursive: true, force: true }); }
});
