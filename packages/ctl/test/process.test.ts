import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { alive, killTree } from "../src/process.ts";

const linux = { skip: process.platform !== "linux" };
function statFields(pid: number): string[] | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	} catch { return null; }
}
async function reported(child: ChildProcess, ms = 8000): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const [chunk] = await Promise.race([
			once(child.stdout!, "data") as Promise<[Buffer]>,
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The fixture never reported its descendant pid.")), ms); }),
		]);
		return Number(chunk.toString().trim());
	} finally { if (timer) clearTimeout(timer); }
}
// The audit could not hit the ESRCH window in 2400 real rounds: the target has
// to vanish in the microseconds between the liveness check and the signal. The
// errno is injected at the syscall boundary instead, and the target is killed
// for real, so the code under test sees exactly what the kernel can produce.
function injectKillError(pid: number, code: "ESRCH" | "EPERM", vanish: boolean): () => void {
	const real = process.kill;
	process.kill = (target: number, signal?: NodeJS.Signals | number) => {
		if (target === pid && signal !== 0) {
			if (vanish) real.call(process, pid, "SIGKILL");
			const error = new Error(`kill ${code}`) as NodeJS.ErrnoException;
			error.code = code;
			throw error;
		}
		return real.call(process, target, signal);
	};
	return () => { process.kill = real; };
}
test("killTree treats a target that vanished before the signal as already stopped", { timeout: 20000, ...linux }, async () => {
	// A bare child has no process group of its own, so this pins the fallback.
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	const restore = injectKillError(child.pid!, "ESRCH", true);
	try {
		await killTree(child.pid!);
		assert.equal(alive(child.pid!), false, "A target that vanished must be reported stopped, not as a raw ESRCH.");
	} finally { restore(); }
});
test("killTree names a refused signal instead of leaking the raw errno", { timeout: 20000, ...linux }, async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	const restore = injectKillError(child.pid!, "EPERM", false);
	try {
		await assert.rejects(killTree(child.pid!), (error: any) => error.code === "PROCESS_FAILED" && error.message.includes("EPERM"));
		assert.equal(alive(child.pid!), true, "A refused signal must leave the process running.");
	} finally {
		restore();
		child.kill("SIGKILL");
		await once(child, "exit").catch(() => {});
	}
});
test("killTree stops the group a reaped leader leaves behind", { timeout: 20000, ...linux }, async () => {
	// detached() makes the child a group leader; the descendant stays in that
	// group after the leader is reaped, and only a group signal reaches it.
	const leader = spawn(process.execPath, ["-e",
		`const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); console.log(child.pid);`],
		{ stdio: ["ignore", "pipe", "ignore"], detached: true });
	const descendant = await reported(leader);
	await once(leader, "exit");
	const fields = statFields(descendant);
	assert.equal(Number(fields?.[2]), leader.pid, "The descendant must still belong to the leader's group.");
	assert.equal(alive(leader.pid!), false, "The leader must be reaped before the kill.");
	try {
		await killTree(leader.pid!);
		assert.equal(alive(descendant), false, "A descendant must not outlive the group leader that the record names.");
	} finally { try { process.kill(descendant, "SIGKILL"); } catch {} }
});
test("killTree escalates SIGKILL until a SIGTERM-ignoring group member is gone", { timeout: 30000, ...linux }, async () => {
	const stubborn = `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`;
	const leader = spawn(process.execPath, ["-e",
		`const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { stdio: ["ignore", "pipe", "ignore"] }); child.stdout.on("data", chunk => { if (String(chunk).includes("ready")) console.log(child.pid); }); setInterval(() => {}, 1000);`],
		{ stdio: ["ignore", "pipe", "ignore"], detached: true });
	const descendant = await reported(leader);
	assert.equal(Number(statFields(descendant)?.[2]), leader.pid, "The stubborn descendant must belong to the leader's group.");
	try {
		const started = Date.now();
		await killTree(leader.pid!);
		const elapsed = Date.now() - started;
		assert.equal(alive(leader.pid!), false, "The leader must stop.");
		assert.equal(alive(descendant), false, "A group member that ignores SIGTERM must not survive as a reported success.");
		assert.ok(elapsed >= 4900, `The SIGKILL escalation must wait out the group's grace period, not ${elapsed}ms.`);
	} finally { try { process.kill(descendant, "SIGKILL"); } catch {} }
});
