import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { detached, ownedProcess, ownershipNonce, ownershipReady, powershell, releaseSpawned, sleep } from "../src/process.ts";
import { helperEnvironment, pathExecutable, windowsExecutable } from "../src/executables.ts";

test("real ownership ignores planted cwd powershell.exe and helper environment excludes unknown secrets", { skip: process.platform !== "win32", timeout: 20000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-executables-"));
	const before = process.cwd();
	let child;
	try {
		await copyFile(process.execPath, resolve(root, "powershell.exe"));
		await copyFile(process.execPath, resolve(root, "pwsh.exe"));
		process.chdir(root);
		const nonce = ownershipNonce();
		child = await detached("-e", nonce, root, process.env, resolve(root, "child.log"), ["setInterval(()=>{},1000)"]);
		const deadline = Date.now() + 5000;
		while (!(await ownershipReady(child, nonce)) && Date.now() < deadline) await sleep(20);
		assert.equal(await ownedProcess(child.pid!, nonce), true, "A planted Node binary would fail the helper's PowerShell args.");
		assert.notEqual(pathExecutable("pwsh"), resolve(root, "pwsh.exe"));
		assert.notEqual(windowsExecutable("powershell.exe"), resolve(root, "powershell.exe"));
		process.env.ACQUIT_OPAQUE_CREDENTIAL = "synthetic-only";
		assert.equal(helperEnvironment().ACQUIT_OPAQUE_CREDENTIAL, undefined);
		const result = await powershell(["-Command", 'if($env:ACQUIT_OPAQUE_CREDENTIAL){exit 1}; "minimal"'], root);
		assert.equal(result.stdout.trim(), "minimal");
	} finally {
		delete process.env.ACQUIT_OPAQUE_CREDENTIAL;
		process.chdir(before);
		if (child) await releaseSpawned(child);
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a real failing PATH pwsh falls back to absolute Windows PowerShell", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-pwsh-fallback-"));
	try {
		await copyFile(process.execPath, resolve(root, "pwsh.exe"));
		const module = new URL("../src/process.ts", import.meta.url).href;
		const script = `import {powershell} from ${JSON.stringify(module)}; const r=await powershell(["-Command",'"fallback"'],process.cwd()); if(r.stdout.trim()!=="fallback")process.exit(1);`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: tmpdir(), env: { ...helperEnvironment(), PATH: root }, encoding: "utf8", timeout: 12000, stdio: ["ignore", "pipe", "ignore"],
		});
		assert.equal(result.status, 0, "The fake pwsh is Node (rejects -NoProfile); only the absolute fallback can pass.");
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
