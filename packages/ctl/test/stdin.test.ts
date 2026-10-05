import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { captured } from "../src/process.ts";

test("captured commands deliver input through stdin without adding it to arguments", async () => {
	const script = 'let text=""; process.stdin.on("data",chunk=>text+=chunk); process.stdin.on("end",()=>console.log(JSON.stringify({input:text,args:process.argv.slice(1)})));';
	const result = await captured(process.execPath, ["-e", script], tmpdir(), process.env, 5000, "test input through stdin");
	assert.equal(result.code, 0);
	assert.deepEqual(JSON.parse(result.stdout), { input: "test input through stdin", args: [] });
});
