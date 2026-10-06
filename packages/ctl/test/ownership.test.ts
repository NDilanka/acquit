import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { alive, detached, ownedProcess, ownershipChannel, ownershipNonce, ownershipReady, releaseSpawned, sleep } from "../src/process.ts";
import { stop } from "../src/commands.ts";
import { atomicJson } from "../src/state.ts";

test("a real pipe squatter answering the victim pid cannot authorize stop; failed preload bind exits", { timeout: 20000, skip: process.platform !== "win32" }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-squatter-"));
	const nonce = ownershipNonce();
	const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
	const squatter = spawn(process.execPath, ["-e", `const {createServer}=require("node:net");
		createServer(s=>{s.on("error",()=>{});s.on("data",()=>s.end("${victim.pid} 0\\n"));}).listen(${JSON.stringify(ownershipChannel(nonce))},()=>console.log("held"));`],
		{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	let child;
	try {
		await Promise.race([once(squatter.stdout!, "data"), sleep(5000).then(() => { throw new Error("Squatter did not bind."); })]);
		assert.equal(await ownedProcess(victim.pid!, nonce), false);
		const dir = resolve(root, "data/ctl");
		const ctx = { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "test.db"), apiPort: 4310, webPort: 5173, browserSession: "test" };
		const { atomicJson } = await import("../src/state.ts");
		await atomicJson(ctx.stateFile, { api: { pid: victim.pid, nonce, port: 4310 }, web: { pid: 0, nonce: ownershipNonce(), port: 5173 }, logs: { api: "", web: "" }, databasePath: ctx.databasePath, startedAt: "test" });
		await assert.rejects(stop({}, ctx), (error: any) => error.code === "PID_MISMATCH");
		assert.equal(alive(victim.pid!), true, "The victim must survive the squatter's forged answer.");
		child = await detached("-e", nonce, root, process.env, resolve(root, "child.log"), ["setInterval(()=>{},1000)"]);
		const deadline = Date.now() + 3000;
		while (child.exitCode === null && Date.now() < deadline) await sleep(20);
		assert.equal(child.exitCode, 1, "The child must fail fast when it cannot bind its proof channel.");
	} finally {
		await releaseSpawned(victim);
		await releaseSpawned(squatter);
		squatter.stdout?.destroy();
		if (child) await releaseSpawned(child);
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a Unix socket squatter answering the victim pid cannot authorize stop; failed preload bind exits", { timeout: 20000, skip: process.platform !== "linux" }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-unix-squatter-"));
	const nonce = ownershipNonce();
	const socketPath = resolve(root, "own.sock");
	const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	const squatter = spawn(process.execPath, ["-e", `const {createServer}=require("node:net");
		createServer(s=>{s.on("error",()=>{});s.on("data",()=>s.end("${victim.pid} 0\\n"));}).listen(${JSON.stringify(socketPath)},()=>console.log("held"));`],
		{ stdio: ["ignore", "pipe", "ignore"] });
	let child;
	try {
		await Promise.race([once(squatter.stdout!, "data"), sleep(5000).then(() => { throw new Error("Squatter did not bind."); })]);
		// The squatter answers with the victim's pid, but it is the process
		// holding the listening socket, so the answer is not kill authority.
		assert.equal(await ownedProcess(victim.pid!, nonce, socketPath), false);
		const dir = resolve(root, "data/ctl");
		const ctx = { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "test.db"), apiPort: 4310, webPort: 5173, browserSession: "test" };
		const { atomicJson } = await import("../src/state.ts");
		await atomicJson(ctx.stateFile, { api: { pid: victim.pid, nonce, port: 4310, socketPath }, web: { pid: 0, nonce: ownershipNonce(), port: 5173 },
			logs: { api: "", web: "" }, databasePath: ctx.databasePath, startedAt: "test" });
		await assert.rejects(stop({}, ctx), (error: any) => error.code === "PID_MISMATCH");
		assert.equal(alive(victim.pid!), true, "The victim must survive the squatter's forged answer.");
		child = await detached("-e", nonce, root, process.env, resolve(root, "child.log"), ["setInterval(()=>{},1000)"], socketPath);
		const deadline = Date.now() + 3000;
		while (child.exitCode === null && Date.now() < deadline) await sleep(20);
		assert.equal(child.exitCode, 1, "The child must fail fast when it cannot bind its proof channel.");
	} finally {
		await releaseSpawned(victim);
		await releaseSpawned(squatter);
		squatter.stdout?.destroy();
		if (child) await releaseSpawned(child);
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("the real ownership server closes idle and oversized clients and does not keep a finished child alive", { timeout: 15000, skip: process.platform !== "win32" }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-pipe-limits-"));
	const nonce = ownershipNonce();
	const child = await detached("-e", nonce, root, process.env, resolve(root, "child.log"), ["setTimeout(()=>{},4000)"]);
	const sockets: ReturnType<typeof createConnection>[] = [];
	try {
		const deadline = Date.now() + 3000;
		while (!(await ownershipReady(child, nonce)) && Date.now() < deadline) await sleep(20);
		for (const input of ["", "x".repeat(257)]) {
			const socket = createConnection(ownershipChannel(nonce));
			sockets.push(socket);
			socket.on("error", () => {});
			await once(socket, "connect");
			const closed = once(socket, "close");
			if (input) socket.write(input);
			await Promise.race([closed, sleep(2000).then(() => { throw new Error("Ownership client was not closed."); })]);
		}
		const idle = createConnection(ownershipChannel(nonce));
		sockets.push(idle);
		idle.on("error", () => {});
		await once(idle, "connect");
		const exitDeadline = Date.now() + 6000;
		while (alive(child.pid!) && Date.now() < exitDeadline) await sleep(20);
		assert.equal(alive(child.pid!), false, "Neither proof listener nor clients may keep a finished service alive.");
	} finally {
		for (const socket of sockets) socket.destroy();
		await releaseSpawned(child);
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

// The forged-authority cases below write a run file exactly as start does, from
// the victim's own /proc facts, then let another process answer the challenge.
// stop must refuse with PID_MISMATCH and leave the victim running.
const linux = { skip: process.platform !== "linux" };
function listeningInodes(path: string): number[] {
	return readFileSync("/proc/net/unix", "utf8").split("\n").slice(1).flatMap(line => {
		const fields = line.trim().split(/\s+/);
		const inode = Number(fields[6]);
		return fields.length > 7 && fields[3] === "00010000" && Number.isSafeInteger(inode) && fields.slice(7).join(" ") === path ? [inode] : [];
	});
}
function socketInodesOf(pid: number): number[] {
	return readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
		try {
			const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			return target.startsWith("socket:[") ? [Number(target.slice(8, -1))] : [];
		} catch { return []; }
	});
}
function listenerInodeOf(pid: number, path: string): number {
	const held = socketInodesOf(pid).filter(inode => listeningInodes(path).includes(inode));
	assert.equal(held.length, 1, "the fixture must hold exactly one listener inode at its path");
	return held[0];
}
function startTimeOf(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
async function spawnProbe(code: string, ...args: string[]): Promise<{ child: ChildProcess; message: string }> {
	const child = spawn(process.execPath, ["-e", code, ...args], { stdio: ["ignore", "pipe", "ignore"] });
	const [chunk] = await Promise.race([once(child.stdout!, "data"), sleep(4000).then(() => { throw new Error("Probe child did not become ready."); })]);
	return { child, message: chunk.toString().trim() };
}
const plainListener = (path: string) => `require("node:net").createServer(s => { s.on("error", () => {}); s.on("data", () => s.end("unrelated\\n")); }).listen(${JSON.stringify(path)}, () => console.log("ready"));`;
const forgerListener = (path: string, victimPid: number) => `require("node:net").createServer(s => { s.on("error", () => {}); s.on("data", () => s.end("${victimPid} 0\\n")); }).listen(${JSON.stringify(path)}, () => console.log("ready"));`;
function probeContext(root: string, name: string, apiPort: number, webPort: number) {
	const dir = resolve(root, name);
	return { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "unused.db"), apiPort, webPort, browserSession: "probe" };
}
async function recordRun(ctx: { stateFile: string; databasePath: string; apiPort: number; webPort: number }, api: Record<string, unknown>): Promise<void> {
	await atomicJson(ctx.stateFile, { api, web: { pid: 0, nonce: ownershipNonce(), port: ctx.webPort },
		logs: { api: "", web: "" }, databasePath: ctx.databasePath, startedAt: "fixture" });
}
async function releaseProbes(root: string, children: (ChildProcess | undefined)[]): Promise<void> {
	for (const child of children) if (child) await releaseSpawned(child);
	await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
test("stop refuses an unlinked listener whose path a forger rebound while answering with the victim PID", { timeout: 20000, ...linux }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-rebind-"));
	const path = resolve(root, "rebind.sock");
	const nonce = ownershipNonce();
	let victim: ChildProcess | undefined;
	let squatter: ChildProcess | undefined;
	try {
		victim = (await spawnProbe(plainListener(path))).child;
		const record = { pid: victim.pid, nonce, port: 64900, socketPath: path, startTime: startTimeOf(victim.pid!), listenerInode: listenerInodeOf(victim.pid!, path) };
		await unlink(path);
		squatter = (await spawnProbe(forgerListener(path, victim.pid!))).child;
		const ctx = probeContext(root, "rebind", 64900, 64901);
		await recordRun(ctx, record);
		await assert.rejects(stop({}, ctx), (error: any) => error.code === "PID_MISMATCH");
		assert.equal(alive(victim.pid!), true, "The recorded process must survive a forger answering with its PID.");
		assert.equal(alive(squatter.pid!), true, "The forger is not ours to stop.");
	} finally { await releaseProbes(root, [victim, squatter]); }
});
test("stop refuses a symlink planted at the recorded socket path", { timeout: 20000, ...linux }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-symlink-"));
	const original = resolve(root, "original.sock");
	const replacement = resolve(root, "replacement.sock");
	const nonce = ownershipNonce();
	let victim: ChildProcess | undefined;
	let squatter: ChildProcess | undefined;
	try {
		victim = (await spawnProbe(plainListener(original))).child;
		const record = { pid: victim.pid, nonce, port: 64902, socketPath: original, startTime: startTimeOf(victim.pid!), listenerInode: listenerInodeOf(victim.pid!, original) };
		await unlink(original);
		squatter = (await spawnProbe(forgerListener(replacement, victim.pid!))).child;
		await symlink(replacement, original);
		const ctx = probeContext(root, "symlink", 64902, 64903);
		await recordRun(ctx, record);
		await assert.rejects(stop({}, ctx), (error: any) => error.code === "PID_MISMATCH");
		assert.equal(alive(victim.pid!), true, "The recorded process must survive a symlinked path.");
		assert.equal(alive(squatter.pid!), true);
	} finally { await releaseProbes(root, [victim, squatter]); }
});
test("stop refuses a duplicated listener fd held by an idle process the record names", { timeout: 20000, ...linux }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-duplicate-"));
	const path = resolve(root, "shared.sock");
	const nonce = ownershipNonce();
	const fixture = `
		const { readFileSync, readdirSync, readlinkSync } = require("node:fs");
		const { spawn } = require("node:child_process");
		const path = process.argv[1];
		require("node:net").createServer(s => { s.on("error", () => {}); s.on("data", () => s.end(process.env.ACQUIT_ANSWER + " 0\\n")); }).listen(path, () => {
			const bound = new Set(readFileSync("/proc/net/unix", "utf8").split("\\n").slice(1).flatMap(line => {
				const fields = line.trim().split(/\\s+/);
				return fields.length > 7 && fields[3] === "00010000" && fields.slice(7).join(" ") === path ? [Number(fields[6])] : [];
			}));
			const fd = readdirSync("/proc/self/fd").find(entry => {
				try { const target = readlinkSync("/proc/self/fd/" + entry); return target.startsWith("socket:[") && bound.has(Number(target.slice(8, -1))); } catch { return false; }
			});
			const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", Number(fd)] });
			holder.unref();
			process.env.ACQUIT_ANSWER = String(holder.pid);
			console.log(JSON.stringify({ answeringPid: process.pid, holderPid: holder.pid }));
		});
	`;
	let answering: ChildProcess | undefined;
	try {
		const ready = await spawnProbe(fixture, path);
		answering = ready.child;
		const { holderPid } = JSON.parse(ready.message) as { answeringPid: number; holderPid: number };
		assert.equal(socketInodesOf(holderPid).includes(listenerInodeOf(answering.pid!, path)), true, "The idle holder must share the listener inode.");
		const record = { pid: holderPid, nonce, port: 64904, socketPath: path, startTime: startTimeOf(holderPid), listenerInode: listenerInodeOf(holderPid, path) };
		const ctx = probeContext(root, "duplicate", 64904, 64905);
		await recordRun(ctx, record);
		await assert.rejects(stop({}, ctx), (error: any) => error.code === "PID_MISMATCH");
		assert.equal(alive(holderPid), true, "An idle process holding a duplicated fd must survive.");
		assert.equal(alive(answering.pid!), true);
	} finally { await releaseProbes(root, [answering]); }
});
test("stop refuses a record whose start time does not match the live PID, and accepts the true one", { timeout: 20000, ...linux }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-starttime-"));
	const path = resolve(root, "own.sock");
	const nonce = ownershipNonce();
	let child: ChildProcess | undefined;
	try {
		child = await detached("-e", nonce, root, process.env, resolve(root, "child.log"), ["setInterval(() => {}, 1000)"], path);
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && listeningInodes(path).length === 0) await sleep(20);
		const record = { pid: child.pid, nonce, port: 64906, socketPath: path, startTime: "1", listenerInode: listenerInodeOf(child.pid!, path) };
		const ctx = probeContext(root, "start-time", 64906, 64907);
		await recordRun(ctx, record);
		await assert.rejects(stop({}, ctx), (error: any) => error.code === "PID_MISMATCH");
		assert.equal(alive(child.pid!), true, "A stale start time must not authorize a kill.");
		await recordRun(ctx, { ...record, startTime: startTimeOf(child.pid!) });
		assert.deepEqual(await stop({}, ctx), { stopped: true, pids: [child.pid] });
	} finally { await releaseProbes(root, [child]); }
});
