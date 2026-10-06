import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
test("status reports only exact worktree suspended argv, without kill commands or adopting a PID", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-suspended-"));
	const nonce = ownershipNonce();
	const preload = resolve(root, "packages/ctl/src/ownership-preload.cjs");
	await mkdir(resolve(root, "packages/ctl/src"), { recursive: true });
	await writeFile(preload, "");
	const children = [
		["--require", preload, "-e", 'console.log("ready");setInterval(()=>{},1000)', "--", nonce],
		["--require", preload, "-e", 'console.log("ready");setInterval(()=>{},1000)', "--", `prefix${nonce}`],
		["--require", preload, "-e", 'console.log("ready");setInterval(()=>{},1000)', "--", nonce, "extra"],
		["-e", 'console.log("ready");setInterval(()=>{},1000)', "--", "--require", preload, nonce],
		["--require", preload, "-e", 'console.log("ready");setInterval(()=>{},1000)', "--", nonce],
	].map(args => spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
	const child = children[0];
	try {
		await Promise.all(children.map(child => once(child.stdout!, "data")));
		const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SuspendOwned { [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint rights,bool inherit,int pid); [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }'; foreach($id in @(${children.map(child => child.pid).join(",")})) { $h=[SuspendOwned]::OpenProcess(0x0800,$false,$id); if($h -eq [IntPtr]::Zero){exit 1}; try { if([SuspendOwned]::NtSuspendProcess($h) -ne 0){exit 1} } finally { [void][SuspendOwned]::CloseHandle($h) } }`;
		assert.equal((await powershell(["-Command", script], root)).code, 0);
		const dir = resolve(root, "data/ctl");
		const ctx = { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "test.db"), apiPort: 4310, webPort: 5173, browserSession: "test" };
		await atomicJson(ctx.stateFile, { api: { pid: 0, nonce, port: 4310 }, web: { pid: 0, nonce: ownershipNonce(), port: 5173 },
			logs: { api: "", web: "" }, databasePath: ctx.databasePath, startedAt: "test" });
		const result = await status({}, ctx) as any;
		assert.equal(result.suspendedRecovery.checked, true);
		assert.deepEqual(result.suspendedRecovery.candidates.map((candidate: any) => candidate.pid).sort(),
			[child.pid, children[4].pid].sort(), "Foreign nonce positions must not be candidates.");
		const [candidate] = result.suspendedRecovery.candidates;
		assert.equal(candidate?.pid, child.pid);
		assert.equal(candidate.recordedPid, 0);
		assert.equal(candidate.ownershipProven, false);
		assert.equal(result.suspendedRecovery.candidates.some((candidate: any) => "manualRecoveryCommand" in candidate), false,
			"Even a same-nonce sibling gets details only, never a PID-reuse-prone kill command.");
		assert.equal(alive(child.pid!), true, "The read-only report must not kill.");
		assert.equal(result.run.api.pid, 0, "The report must not adopt an unproven PID.");
	} finally {
		for (const child of children) { await releaseSpawned(child); child.stdout?.destroy(); }
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
