// The API hands the GitHub organization to the App config. Without it every work-repo call refuses
// with "Missing GITHUB_APP_ORG" even when the operator configured one.

import assert from "node:assert/strict";
import test from "node:test";
import { missingGitHubNames } from "../src/github.ts";

process.env.PAYPAL_CLIENT_ID = "test-client-id";
process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
process.env.ACQUIT_GITHUB_APP_ID = "123456";
process.env.ACQUIT_GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----";
process.env.ACQUIT_GITHUB_APP_ORG = "acquit-forks";

test("the API config carries the GitHub organization the App needs", async () => {
	const { config } = await import("../../../apps/api/src/config.ts");
	const github = config().github as { appId?: string; privateKey?: string; organization?: string };
	assert.equal(github.organization, "acquit-forks");
	assert.deepEqual(missingGitHubNames(github), []);
});
