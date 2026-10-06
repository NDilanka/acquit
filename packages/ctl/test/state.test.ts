import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { atomicJson, locked, lockLabel, lockName } from "../src/state.ts";
import { releaseSpawned, sleep } from "../src/process.ts";

// Recompute the printable label from the path the kernel resolves: reading it
// back from lockLabel would pass a regression to the raw abstract name.
function expectedLockLabel(dir: string): string {
	const real = realpathSync(dir);
	if (process.platform === "linux") return `@acquit-lock-${createHash("sha256").update(real).digest("hex")}`;
	if (process.platform === "win32") return `\\\\.\\pipe\\acquit-lock-${createHash("sha256").update(real.toLowerCase()).digest("hex")}`;
	return resolve(real, "operation.lock");
}

test("Windows lock names hash the entire canonical path, not a shared trailing suffix", { skip: process.platform !== "win32" }, () => {
	const suffix = "same-long-suffix/data/ctl/lane-6";
	assert.notEqual(lockName(resolve("one", suffix)), lockName(resolve("two", suffix)));
	assert.equal(lockName(resolve("ONE", suffix)), lockName(resolve("one", suffix)));
});
test("the printable lock label for a fixed lane path is a pinned literal", () => {
	// sha256("/acquit/fixed/lane"), computed off-tree.
	const hash = "03260014e74f3996f95886a25ee39fc11e10d6afccb055a54c039a1b6017ad3b";
	const expected = process.platform === "linux" ? `@acquit-lock-${hash}`
		: process.platform === "win32" ? `\\\\.\\pipe\\acquit-lock-${hash}`
			: "/acquit/fixed/lane/operation.lock";
	assert.equal(lockLabel("/acquit/fixed/lane"), expected);
});
test("a symlinked spelling of a lane directory cannot enter while the real path holds the lock", { skip: process.platform === "win32", timeout: 10000 }, async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "acquit-lock-alias-"));
	const alias = `${dir}-alias`;
	await symlink(dir, alias, "dir");
	try {
		await locked({ dir } as any, async () => {
			await assert.rejects(locked({ dir: alias } as any, async () => {}), (error: any) => {
				assert.equal(error.code, "CLI_BUSY");
				assert.equal(error.message, `Another CLI lifecycle operation holds ${expectedLockLabel(dir)}.`);
				return true;
			});
		});
		await locked({ dir: alias } as any, async () => {});
	} finally {
		await rm(alias, { force: true });
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
test("off Linux and off Windows a busy lock names the stale socket file and its manual delete", { skip: process.platform === "win32", timeout: 10000 }, async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "acquit-lock-file-"));
	const socketPath = resolve(realpathSync(dir), "operation.lock");
	const platform = process.platform;
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	try {
		await locked({ dir } as any, async () => {
			await assert.rejects(locked({ dir } as any, async () => {}), (error: any) => {
				assert.equal(error.code, "CLI_BUSY");
				assert.equal(error.message, `Another CLI lifecycle operation holds ${socketPath}.`);
				assert.equal(error.fix, `Wait for that command to finish, then retry. If stuck, this lock is the socket file ${socketPath}; a killed holder leaves the file behind, so confirm no live holder, delete that file by hand, and retry. Never delete a run file to bypass this lock.`);
				return true;
			});
		});
	} finally {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
test("a held lock names itself and its recovery; idle clients cannot block lock release", { timeout: 10000 }, async () => {
	const dir = await mkdtemp(resolve(tmpdir(), "acquit-lock-recovery-"));
	try {
		await locked({ dir } as any, async () => {
			await assert.rejects(locked({ dir } as any, async () => {}), (error: any) => error.code === "CLI_BUSY"
				&& error.message === `Another CLI lifecycle operation holds ${expectedLockLabel(dir)}.` && error.fix.includes("Never delete a run file to bypass this lock."));
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
			if (process.platform === "linux" || process.platform === "win32") {
				assert.equal(result, "entered", "A lock whose holder died must not block the next command.");
			} else {
				// Elsewhere the lock is a socket file, and without /proc no later
				// CLI can prove its holder is dead: it fails closed instead.
				assert.equal(result, "CLI_BUSY", "A socket-file lock cannot be reclaimed safely, so the CLI must refuse.");
			}
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
