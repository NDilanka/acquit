import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alive, captured } from "../src/process.ts";

test("release of an unreferenced detached handle keeps the CLI alive until cleanup finishes", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-release-test-"));
	const module = new URL("../src/process.ts", import.meta.url).href;
	const script = `import { detached, releaseSpawned } from ${JSON.stringify(module)};
		import { writeFile } from "node:fs/promises";
		const child = await detached(["-e","setInterval(()=>{},1000)"], process.cwd(), process.env, "child.log");
		await writeFile("pid", String(child.pid));
		await releaseSpawned(child);
		console.log("released");`;
	try {
		const result = await captured(process.execPath, ["--input-type=module", "-e", script], root, process.env, 10000);
		assert.deepEqual(result, { code: 0, stdout: "released\n" });
		assert.equal(alive(Number(await readFile(join(root, "pid"), "utf8"))), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
