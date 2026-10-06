import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { atomicJson, locked, lockLabel, lockName } from "../src/state.ts";
import { releaseSpawned, sleep } from "../src/process.ts";

test("Windows lock names hash the entire canonical path, not a shared trailing suffix", { skip: process.platform !== "win32" }, () => {
	const suffix = "same-long-suffix/data/ctl/lane-6";
	assert.notEqual(lockName(resolve("one", suffix)), lockName(resolve("two", suffix)));
	assert.equal(lockName(resolve("ONE", suffix)), lockName(resolve("one", suffix)));
});
test("a held lock names itself and its recovery; idle clients cannot block lock release", { timeout: 10000 }, async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "acquit-lock-recovery-"));
	try {
		await locked({ dir } as any, async () => {
			await assert.rejects(locked({ dir } as any, async () => {}), (error: any) => error.code === "CLI_BUSY"
				&& error.message.includes(lockLabel(dir)) && error.fix.includes("Never delete a run file to bypass this lock."));
			const socket = createConnection(lockName(dir));
			socket.on("error", () => {});
			await once(socket, "connect");
			socket.destroy();
		});
		await locked({ dir } as any, async () => {});
	} finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
test("a holder killed with SIGKILL does not wedge the next lifecycle operation", { timeout: 20000 }, async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "acquit-lock-stale-"));
	try {
		const holder = spawn(process.execPath, ["--input-type=module", "-e",
			`import { locked } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};
			await locked({ dir: ${JSON.stringify(dir)} }, async () => { console.log("held"); await new Promise(() => {}); });`],
			{ stdio: ["ignore", "pipe", "ignore"] });
		try {
			const [held] = await once(holder.stdout!, "data", { signal: AbortSignal.timeout(5000) });
			assert.equal(String(held).trim(), "held");
			holder.kill("SIGKILL");
			if (holder.exitCode === null && holder.signalCode === null) await once(holder, "exit");
			const result = await locked({ dir } as any, async () => "entered").catch((error: any) => error.code);
			assert.equal(result, "entered", "A holder killed with SIGKILL must not leave a lock that blocks the next command.");
		} finally { holder.kill("SIGKILL"); }
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
