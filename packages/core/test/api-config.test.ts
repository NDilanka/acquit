// The API hands the GitHub organization to the App config. Without it every work-repo call refuses
// with "Missing GITHUB_APP_ORG" even when the operator configured one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { missingGitHubNames } from "../src/github.ts";

process.env.PAYPAL_CLIENT_ID = "test-client-id";
process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
process.env.ACQUIT_GITHUB_APP_ID = "123456";
process.env.ACQUIT_GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----";
process.env.ACQUIT_GITHUB_APP_ORG = "acquit-forks";
// The API derives the hidden-case contract at boot. A development process falls back to the committed example.
process.env.ACQUIT_DEV = "1";

test("the API config carries the GitHub organization the App needs", async () => {
	const { config } = await import("../../../apps/api/src/config.ts");
	const github = config().github as { appId?: string; privateKey?: string; organization?: string };
	assert.equal(github.organization, "acquit-forks");
	assert.deepEqual(missingGitHubNames(github), []);
});

test("the API refuses the child-process subject at startup, before it listens", () => {
	const server = fileURLToPath(new URL("../../../apps/api/src/server.ts", import.meta.url));
	const example = fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.example.json", import.meta.url));
	const child = spawnSync(process.execPath, [server], { encoding: "utf8", timeout: 15_000,
		env: { ...process.env, ACQUIT_VERIFIER_SUBJECT: "child", ACQUIT_DEV: "0", ACQUIT_HIDDEN_CASES: example, PORT: "0" } });
	assert.equal(child.status, 1);
	assert.match(child.stderr, /SUBJECT_CHILD_REFUSED/);
	assert.equal(child.stderr.includes("Acquit API:"), false);
});
