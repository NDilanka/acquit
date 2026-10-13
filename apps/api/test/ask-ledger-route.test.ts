// The ask routes over real HTTP: the closed read-only tool set answers the platform role alone,
// a tool call executes against the real book, and a turn without a usable provider key is refused
// before any call is attempted (the boot below points HOME at an empty dir, so no droid can spawn).

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function bootServer(port: number, dbPath: string, home: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673",
				HOME: home, FACTORY_API_KEY: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => rejectBoot(new Error(`server did not boot: ${out} ${err}`)), 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			out += String(chunk);
			if (out.includes("Acquit API:")) { clearTimeout(timer); resolveBoot(child); }
		});
		child.stderr.on("data", (chunk: Buffer) => { err += String(chunk); });
		child.on("exit", (code) => { clearTimeout(timer); rejectBoot(new Error(`server exited early (${code}): ${out} ${err}`)); });
	});
}

const post = (port: number, path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });

const get = (port: number, path: string, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("the ask routes answer the platform role alone, and the tool set is the closed read-only one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-ask-route-"));
	const port = 4879;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), join(dir, "homeless"));
		const minted = await post(port, "/api/platform/session", { key: "test-platform-key-0123456789abcdef" });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };

		const anonymous = await get(port, "/api/ask-ledger/tools");
		assert.equal(anonymous.status, 401, "an unauthenticated ask route is refused before anything else");

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		for (const attempt of [get(port, "/api/ask-ledger/tools", clientToken),
			post(port, "/api/ask-ledger/turn", { messages: [{ id: "m1", role: "user", content: "hello" }] }, clientToken),
			post(port, "/api/ask-ledger/tool", { name: "platform_totals", arguments: {} }, clientToken)]) {
			const refused = await attempt;
			assert.equal(refused.status, 403, "a client session is not the platform role");
		}

		const tools = await get(port, "/api/ask-ledger/tools", token);
		assert.equal(tools.status, 200);
		const listed = await tools.json() as { tools: { name: string }[]; model: string; keyConfigured: boolean };
		assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["get_job", "get_order", "list_jobs", "platform_totals"]);
		assert.equal(listed.model, "glm-5.3-flash", "the default provider's ask model is the ruled one");
		assert.equal(listed.keyConfigured, false, "a boot with no Factory key says so, without naming one");

		const totals = await post(port, "/api/ask-ledger/tool", { name: "platform_totals", arguments: {} }, token);
		assert.equal(totals.status, 200);
		assert.deepEqual(await totals.json() as unknown, { result: { held: 0, released: 0, refunded: 0, fees: 0, heldJobs: 0 } });

		const unknownTool = await post(port, "/api/ask-ledger/tool", { name: "capture_order", arguments: {} }, token);
		assert.equal(unknownTool.status, 502, "the executor is a closed set");

		const turn = await post(port, "/api/ask-ledger/turn",
			{ messages: [{ id: "m1", role: "user", content: "How much escrow is held right now, and does PayPal agree?" }] }, token);
		assert.equal(turn.status, 503, "no usable provider key, no turn");
		const refused = await turn.json() as { error: string };
		assert.equal(refused.error, "MODEL_KEY_MISSING");
		const log = await readFile(join(dir, "model-calls.jsonl"), "utf8");
		const records = log.split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line) as { caller: string; phase: string });
		assert.deepEqual(records.map(record => [record.caller, record.phase]),
			[["ask-ledger", "START"], ["ask-ledger", "END"]], "the refused turn still counts against the shared budget");
	} finally {
		child?.kill("SIGTERM");
		await rm(dir, { recursive: true, force: true });
	}
});
