// The House bids on every open job. A deployment that was never seeded has no House rows, and that is
// a fact of the deployment, not of the tick: one line per process, not one per tick.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import type { Actor } from "../src/acquit.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { ClientId, MerchantId } from "../src/ids.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { exampleContract } from "./hidden-fixture.ts";

const merchant = "sandbox-seller" as MerchantId;
const deployment = "maya-client/invoice-app";

test("an unseeded deployment logs the House's refusal once, not once per tick", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-house-"));
	const path = join(root, "acquit.db");
	const service = createAcquit({ databaseUrl: path, hiddenContract: exampleContract, demo: { merchant },
		clock: { now: () => instant("2026-10-06T12:00:00Z") },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	const lines: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	try {
		const own: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
		const opened = await service.execute(own, parseRequestKey(randomUUID()), { type: "OpenJob", repository: deployment,
			issueNumber: 12, budget: usd("400.00"), deliveryEndsAt: instant("2026-10-12T12:00:00Z") });
		assert.equal(opened.kind, "COMMITTED");
		// The open tries the House once, and each tick tries it again: three attempts, one line.
		await service.tick();
		await service.tick();
	} finally {
		console.warn = original;
		closeAcquit(service);
		await rm(root, { recursive: true, force: true });
	}
	assert.equal(lines.length, 1, `expected one House refusal line, saw ${lines.length}: ${lines.join(" | ")}`);
	assert.match(lines[0], /house-tsfix/);
});
