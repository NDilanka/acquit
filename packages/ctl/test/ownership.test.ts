import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { alive, detached, ownedProcess, ownershipChannel, ownershipNonce, ownershipReady, releaseSpawned, sleep } from "../src/process.ts";
import { stop } from "../src/commands.ts";

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
