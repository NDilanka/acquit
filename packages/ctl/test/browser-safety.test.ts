import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { browserListenerPorts } from "../src/browser-safety.ts";
import { powershell, releaseSpawned } from "../src/process.ts";

test("dashboard discovery matches all case-insensitive native names in a stub process list", { skip: process.platform !== "win32" }, async () => {
	const stub = `function Get-CimInstance { @(
		[pscustomobject]@{Name='agent-browser.exe';ProcessId=10},
		[pscustomobject]@{Name='AGENT-BROWSER-WIN32-X64.EXE';ProcessId=11},
		[pscustomobject]@{Name='agent-browser-win32-arm64.exe';ProcessId=12},
		[pscustomobject]@{Name='node.exe';ProcessId=13}) };
	function Get-NetTCPConnection { foreach($id in 10,11,12,13) { [pscustomobject]@{OwningProcess=$id;LocalPort=60000+$id} } }; `;
	const inspect: typeof powershell = (args, cwd) => powershell(["-Command", stub + args[1]], cwd);
	assert.deepEqual(await browserListenerPorts(10, process.cwd(), inspect), [60011, 60012]);
	assert.deepEqual(await browserListenerPorts(11, process.cwd(), inspect), [60010, 60012]);
});
test("dashboard discovery uses real listener ownership, not dashboard argv, and excludes only its own daemon", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-dashboard-"));
	await copyFile(process.execPath, resolve(root, "agent-browser-win32-x64.exe"));
	const child = spawn(resolve(root, "agent-browser-win32-x64.exe"), ["-e", 'require("node:net").createServer(s=>s.destroy()).listen(0,"127.0.0.1",function(){console.log(this.address().port)})'],
		{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	try {
		const [data] = await once(child.stdout!, "data");
		const port = Number(String(data).trim());
		assert((await browserListenerPorts(0, root)).includes(port));
		assert(!(await browserListenerPorts(child.pid!, root)).includes(port));
	} finally {
		await releaseSpawned(child);
		child.stdout?.destroy();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
