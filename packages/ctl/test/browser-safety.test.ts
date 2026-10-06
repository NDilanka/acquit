import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { browserListenerPorts } from "../src/browser-safety.ts";
import { releaseSpawned } from "../src/process.ts";

test("dashboard discovery uses real listener ownership, not dashboard argv, and excludes only its own daemon", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-dashboard-"));
	await copyFile(process.execPath, resolve(root, "agent-browser.exe"));
	const child = spawn(resolve(root, "agent-browser.exe"), ["-e", 'require("node:net").createServer(s=>s.destroy()).listen(0,"127.0.0.1",function(){console.log(this.address().port)})'],
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
