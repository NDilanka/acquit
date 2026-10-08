// The expiry sweep the control CLI runs: a dry run reports what it would remove, a real sweep deletes
// an expired visitor's own repository and then its rows, and a visitor whose repository cannot be
// removed stays for the next sweep. The App is this test's own stub, so no repository is ever touched.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sweep } from "../src/commands.ts";
import type { Context } from "../src/state.ts";
import { instant } from "../../core/src/ids.ts";
import type { MerchantId } from "../../core/src/ids.ts";
import { SqliteStore } from "../../core/src/store.ts";
import { insertVisitor, newVisitorId, readVisitor } from "../../core/src/visitors.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const merchant = "sandbox-seller" as MerchantId;
const NAMES = ["ACQUIT_GITHUB_APP_ID", "ACQUIT_GITHUB_APP_ORG", "ACQUIT_GITHUB_APP_PRIVATE_KEY", "ACQUIT_GITHUB_API_BASE"] as const;

test("sweep reports an expired visitor on a dry run, then removes its repository and its rows", async () => {
	const stub = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		const url = request.url ?? "";
		if (url.startsWith("/app/installations?")) { response.writeHead(200); response.end(JSON.stringify([{ id: 42, account: { login: "acquit-forks" } }])); return; }
		if (url === "/app/installations/42/access_tokens" && request.method === "POST") {
			response.writeHead(201); response.end(JSON.stringify({ token: "ghs_sweep", expires_at: new Date(Date.now() + 3_600_000).toISOString() })); return;
		}
		if (url === "/repos/acquit-forks/demo-old" && request.method === "GET") {
			response.writeHead(200); response.end(JSON.stringify({ full_name: "acquit-forks/demo-old", fork: true,
				parent: { full_name: "maya-client/invoice-app" } })); return;
		}
		if (url === "/repos/acquit-forks/demo-old" && request.method === "DELETE") { response.writeHead(204); response.end(); return; }
		response.writeHead(404); response.end(JSON.stringify({ message: "Not Found" }));
	});
	await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", () => resolve()));
	const stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
	const dir = await mkdtemp(join(tmpdir(), "acquit-sweep-"));
	const path = join(dir, "acquit.db");
	const store = new SqliteStore(path);
	const expired = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-a", repository: "acquit-forks/demo-old",
		merchant, now: instant(new Date(Date.now() - 3 * 86_400_000).toISOString()) });
	const staying = insertVisitor(store.db, { id: newVisitorId(), ipKey: "ip-b", repository: "acquit-forks/demo-live",
		merchant, now: instant(new Date().toISOString()) });
	store.close();
	const ctx: Context = { root, dir, stateFile: join(dir, "run.json"), databasePath: path, apiPort: 4310, webPort: 5173,
		verifierPort: 4311, browserSession: "acquit-sweep-test" };
	const saved = new Map(NAMES.map(name => [name, process.env[name]]));
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	try {
		// A dry run reports the expired visitor, removes nothing, and needs no App at all.
		const dry = await sweep({ "dry-run": true }, ctx);
		assert.deepEqual((dry.expired as { id: string }[]).map(visitor => visitor.id), [expired.id]);
		const peek = new SqliteStore(path);
		assert.equal(readVisitor(peek.db, expired.id)?.id, expired.id);
		peek.close();
		// The real sweep needs the App, and the repository it removes is the visitor's own.
		process.env.ACQUIT_GITHUB_APP_ID = "4242";
		process.env.ACQUIT_GITHUB_APP_ORG = "acquit-forks";
		process.env.ACQUIT_GITHUB_API_BASE = stubBase;
		process.env.ACQUIT_GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const report = await sweep({}, ctx);
		assert.deepEqual(report.swept, [expired.id]);
		assert.deepEqual(report.repositories, [{ repository: "acquit-forks/demo-old", outcome: "DELETED" }]);
		assert.deepEqual(report.kept, []);
		const after = new SqliteStore(path);
		assert.equal(readVisitor(after.db, expired.id)?.state, "SWEPT");
		assert.equal(readVisitor(after.db, staying.id)?.state, "ACTIVE");
		after.close();
		// Idempotent: a second sweep has nothing left to do.
		assert.deepEqual(await sweep({}, ctx), { databasePath: path, swept: [], repositories: [], kept: [] });
	} finally {
		for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value;
		await rm(dir, { recursive: true, force: true });
		stub.closeAllConnections();
		await new Promise<void>(resolve => stub.close(() => resolve()));
	}
});
