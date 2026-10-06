import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { atomicJson, locked, lockName } from "../src/state.ts";
import { releaseSpawned, sleep } from "../src/process.ts";

test("Windows lock names hash the entire canonical path, not a shared trailing suffix", { skip: process.platform !== "win32" }, () => {
	const suffix = "same-long-suffix/data/ctl/lane-6";
	assert.notEqual(lockName(resolve("one", suffix)), lockName(resolve("two", suffix)));
	assert.equal(lockName(resolve("ONE", suffix)), lockName(resolve("one", suffix)));
});
test("a squatted lock names its pipe and recovery; idle clients cannot block lock release", { timeout: 10000 }, async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "acquit-lock-recovery-"));
	try {
		await locked({ dir } as any, async () => {
			await assert.rejects(locked({ dir } as any, async () => {}), (error: any) => error.code === "CLI_BUSY"
				&& error.message.includes(lockName(dir)) && error.fix.includes("process exit releases"));
			const socket = createConnection(lockName(dir));
			socket.on("error", () => {});
			await once(socket, "connect");
			socket.destroy();
		});
		await locked({ dir } as any, async () => {});
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
test("atomic replacement retries a real Windows non-delete-sharing reader and reruns the publish guard", { timeout: 20000, skip: process.platform !== "win32" }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-rename-"));
	const path = resolve(root, "run.json");
	await atomicJson(path, { old: true });
	const script = `$f=[IO.File]::Open('${path.replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); 'held'; Start-Sleep -Milliseconds 500; $f.Dispose()`;
	const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	try {
		await Promise.race([once(holder.stdout!, "data"), sleep(5000).then(() => { throw new Error("Reader did not acquire its handle."); })]);
		let guarded = 0;
		await atomicJson(path, { new: true }, () => guarded++);
		assert(guarded > 1, "The real sharing violation must force a guarded retry.");
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { new: true });
	} finally {
		await releaseSpawned(holder);
		holder.stdout?.destroy();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
