// The platform stream over real HTTP: the platform role holds the stream open, a committed write reaches it
// as a "changed" event within two seconds, and every other holder is refused before the stream opens.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const PLATFORM_KEY = "test-platform-key-0123456789abcdef";

function bootServer(port: number, dbPath: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_PLATFORM_KEY: PLATFORM_KEY,
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673",
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

const post = (port: number, path: string, payload: unknown) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Polls until the check passes or the deadline lapses; resolves to whether it passed. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) return false;
		await sleep(10);
	}
	return true;
}

/** Accumulates a stream's decoded text in the background, so a test can read what has arrived so far. */
function collect(body: ReadableStream<Uint8Array>): { text: () => string } {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				text += decoder.decode(value, { stream: true });
			}
		} catch {
			// The stream ended when the test cancelled it or the server closed.
		}
	})();
	return { text: () => text };
}

test("the platform stream refuses everyone but the platform role, and a committed write reaches it within two seconds", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-stream-"));
	const port = 4897;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"));
		const minted = await post(port, "/api/platform/session", { key: PLATFORM_KEY });
		assert.equal(minted.status, 201);
		const { token } = await minted.json() as { token: string };

		const anonymous = await fetch(`http://127.0.0.1:${port}/api/platform/stream`);
		assert.equal(anonymous.status, 401);

		const signedIn = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signedIn.status, 200);
		const { token: clientToken } = await signedIn.json() as { token: string };
		const client = await fetch(`http://127.0.0.1:${port}/api/platform/stream`, { headers: { authorization: `Bearer ${clientToken}` } });
		assert.equal(client.status, 403);
		assert.deepEqual(await client.json(), { error: "PLATFORM_ONLY" });

		const stream = await fetch(`http://127.0.0.1:${port}/api/platform/stream`, { headers: { authorization: `Bearer ${token}` } });
		assert.equal(stream.status, 200);
		assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
		const open = collect(stream.body!);
		assert.ok(await until(() => open.text().includes("retry: 2000\n\n"), 5_000), "the stream opens with its retry hint");

		// An idle stream sends no change: opening it writes nothing the watcher counts.
		await sleep(1_200);
		assert.doesNotMatch(open.text(), /data: /);

		// A dev webhook with an unrouted event type is still a committed webhook_events row: a write by the
		// core's own connection, which the stream's connection must see.
		const probe = (id: string) => ({ id, event_type: "CUSTOMER.STREAM.PROBE", resource_type: "stream_probe", resource: { id: `PROBE-${id}` } });
		const started = Date.now();
		const first = await post(port, "/api/dev/paypal/webhook", probe("WH-STREAM-1"));
		assert.equal(first.status, 202);
		assert.deepEqual(await first.json(), { received: true });
		const arrived = await until(() => open.text().includes('data: {"kind":"changed"'), 2_000);
		const elapsed = Date.now() - started;
		assert.ok(arrived, "a change event arrives after the write");
		assert.ok(elapsed < 2_000, `the event arrives within two seconds (took ${elapsed} ms)`);

		const frame = open.text().split("\n").find((line) => line.startsWith("data: {\"kind\":\"changed\""));
		assert.ok(frame, "the event is one data line");
		const event = JSON.parse(frame.slice("data: ".length)) as { kind: string; at: string };
		assert.equal(event.kind, "changed");
		assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);

		// Each further commit is a further event, so a second write after the first is also seen.
		const countBefore = open.text().split('data: {"kind":"changed"').length - 1;
		assert.equal((await post(port, "/api/dev/paypal/webhook", probe("WH-STREAM-2"))).status, 202);
		assert.ok(await until(() => open.text().split('data: {"kind":"changed"').length - 1 > countBefore, 2_000),
			"a second commit sends a second event");

		// A write through the API's own connection is a commit too: the CLI login mints its code row there, and
		// no other connection writes in this step, so only a stream that watches its own connection sees it.
		const countMain = open.text().split('data: {"kind":"changed"').length - 1;
		const challenge = createHash("sha256").update("stream-test-verifier").digest("base64url");
		assert.equal((await post(port, "/api/cli/codes", { challenge })).status, 201);
		assert.ok(await until(() => open.text().split('data: {"kind":"changed"').length - 1 > countMain, 2_000),
			"a commit on the API's own connection sends an event");
	} finally {
		// Windows keeps the SQLite file locked until the server process has exited; an open stream must not
		// hold the server's shutdown.
		if (child && child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
