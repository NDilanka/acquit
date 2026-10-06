import assert from "node:assert/strict";
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
