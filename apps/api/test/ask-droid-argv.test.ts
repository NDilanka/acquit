import assert from "node:assert/strict";
import { test } from "node:test";
import { droidAskArgv } from "../src/ask.ts";

test("the ask turn runs droid with only the inert TodoWrite tool, so no native read, execute or fetch reaches the host", () => {
	const argv = droidAskArgv("/tmp/acquit-ask-x/ask-instruction.txt");
	const only = argv.indexOf("--only-tools");
	assert.notEqual(only, -1);
	assert.equal(argv[only + 1], "TodoWrite");
	assert.equal(argv.includes("--auto"), false);
	assert.equal(argv.includes("--skip-permissions-unsafe"), false);
	assert.equal(argv.at(-2), "-f");
	assert.equal(argv.at(-1), "/tmp/acquit-ask-x/ask-instruction.txt");
});
