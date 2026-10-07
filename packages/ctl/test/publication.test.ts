import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { alive, captured, detached, ownershipNonce, releaseSpawned, sleep } from "../src/process.ts";
import { atomicJson } from "../src/state.ts";

test("the preload never executes an app before its exact PID and nonce are published", { timeout: 10000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-publication-"));
	const nonce = ownershipNonce();
	const path = resolve(root, "run.json");
	const marker = resolve(root, "app-started");
	await atomicJson(path, { web: { pid: 0, nonce } });
	const child = await detached("-e", nonce, root, { ...process.env, ACQUIT_OWNERSHIP_RECORD: path, ACQUIT_OWNERSHIP_ROLE: "web" }, resolve(root, "child.log"),
		[`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");setInterval(()=>{},1000)`], process.platform === "win32" ? undefined : resolve(root, "own.sock"));
	try {
		await sleep(200);
		assert.equal(existsSync(marker), false);
		await atomicJson(path, { web: { pid: child.pid, nonce } });
		const deadline = Date.now() + 3000;
		while (!existsSync(marker) && Date.now() < deadline) await sleep(20);
		assert.equal(existsSync(marker), true);
	} finally { await releaseSpawned(child); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
test("a killed launcher in the spawn/publication gap leaves no child, pipe, app or descendant", { timeout: 15000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-publication-exit-"));
	const marker = resolve(root, "app-started");
	const script = `import { detached, ownershipNonce } from ${JSON.stringify(new URL("../src/process.ts", import.meta.url).href)};
		import { atomicJson } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};
		const nonce=ownershipNonce(), path=${JSON.stringify(resolve(root, "run.json"))};
		await atomicJson(path,{web:{pid:0,nonce}});
		const child=await detached("-e",nonce,process.cwd(),{...process.env,ACQUIT_OWNERSHIP_RECORD:path,ACQUIT_OWNERSHIP_ROLE:"web"},"child.log",
			[${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");setInterval(()=>{},1000)`)}],${JSON.stringify(process.platform === "win32" ? undefined : resolve(root, "own.sock")) ?? "undefined"});
		console.log(child.pid);
		process.exit(0);`;
	let pid = 0;
	try {
		const result = await captured(process.execPath, ["--input-type=module", "-e", script], root, process.env, 5000);
		assert.equal(result.code, 0);
		pid = Number(result.stdout.trim());
		assert(pid > 0);
		const deadline = Date.now() + 3000;
		while (alive(pid) && Date.now() < deadline) await sleep(20);
		assert.equal(alive(pid), false);
		assert.equal(existsSync(marker), false);
	} finally {
		assert.equal(alive(pid), false, "Do not erase evidence of a surviving unpublished child.");
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
