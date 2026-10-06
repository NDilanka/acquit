import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { alive, ownershipNonce, powershell, releaseSpawned } from "../src/process.ts";
import { allThreadsSuspended } from "../src/suspended.ts";
import { atomicJson } from "../src/state.ts";
import { status } from "../src/commands.ts";

test("suspended classifier requires every thread and does not classify empty/unknown/running observations", () => {
	assert.equal(allThreadsSuspended([{ state: "Wait", reason: "Suspended" }]), true);
	for (const threads of [[], [{ state: "Wait", reason: "Unknown" }], [{ state: "Running", reason: "Suspended" }],
		[{ state: "Wait", reason: "Suspended" }, { state: "Wait", reason: "ExecutionDelay" }]]) assert.equal(allThreadsSuspended(threads), false);
});
test("status reports a real wholly suspended nonce child with pid zero, leaves it alive, and preserves the record", { skip: process.platform !== "win32", timeout: 25000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-suspended-"));
	const nonce = ownershipNonce();
	const child = spawn(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)', "--", nonce],
		{ windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
	try {
		await once(child.stdout!, "data");
		const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SuspendOwned { [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint rights,bool inherit,int pid); [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }'; $h=[SuspendOwned]::OpenProcess(0x0800,$false,${child.pid}); if($h -eq [IntPtr]::Zero){exit 1}; try { if([SuspendOwned]::NtSuspendProcess($h) -ne 0){exit 1} } finally { [void][SuspendOwned]::CloseHandle($h) }`;
		assert.equal((await powershell(["-Command", script], root)).code, 0);
		const dir = resolve(root, "data/ctl");
		const ctx = { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "test.db"), apiPort: 4310, webPort: 5173, browserSession: "test" };
		await atomicJson(ctx.stateFile, { api: { pid: 0, nonce, port: 4310 }, web: { pid: 0, nonce: ownershipNonce(), port: 5173 },
			logs: { api: "", web: "" }, databasePath: ctx.databasePath, startedAt: "test" });
		const result = await status({}, ctx) as any;
		assert.equal(result.suspendedRecovery.checked, true);
		const [candidate] = result.suspendedRecovery.candidates;
		assert.equal(candidate?.pid, child.pid);
		assert.equal(candidate.recordedPid, 0);
		assert.equal(candidate.ownershipProven, false);
		assert(candidate.manualRecoveryCommand.endsWith(`/pid ${child.pid} /t /f`));
		assert.equal(alive(child.pid!), true, "The read-only report must not kill.");
		assert.equal(result.run.api.pid, 0, "The report must not adopt an unproven PID.");
	} finally {
		await releaseSpawned(child);
		child.stdout?.destroy();
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
