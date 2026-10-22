// The API hands the GitHub organization to the App config. Without it every work-repo call refuses
// with "Missing GITHUB_APP_ORG" even when the operator configured one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// House's own PayPal app is optional. Set here, the API config carries it bound to the House merchant.
process.env.HOUSE_PAYPAL_CLIENT_ID = "test-house-client-id";
process.env.HOUSE_PAYPAL_CLIENT_SECRET = "test-house-client-secret";
process.env.OPERATOR_HOUSE_MERCHANT_ID = "TESTHOUSEMERCHANT1";

test("the API config carries House's own credentials, bound to the House merchant", async () => {
	const { config } = await import("../../../apps/api/src/config.ts");
	assert.deepEqual(config().paypal.house, { merchant: "TESTHOUSEMERCHANT1", clientId: "test-house-client-id", secret: "test-house-client-secret" });
});

test("the API refuses to load with a lone House secret, naming the setting and never its value", () => {
	const configUrl = new URL("../../../apps/api/src/config.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(configUrl)})`], { encoding: "utf8", timeout: 15_000,
		env: { ...process.env, HOUSE_PAYPAL_CLIENT_ID: "lone-client-id", HOUSE_PAYPAL_CLIENT_SECRET: "" } });
	assert.equal(child.status, 1);
	assert.match(child.stderr, /Missing configuration: HOUSE_PAYPAL_CLIENT_SECRET/);
	assert.equal(child.stderr.includes("lone-client-id"), false);
});

test("the API config carries the GitHub organization the App needs", async () => {
	const { config } = await import("../../../apps/api/src/config.ts");
	const github = config().github as { appId?: string; privateKey?: string; organization?: string };
	assert.equal(github.organization, "acquit-forks");
	assert.deepEqual(missingGitHubNames(github), []);
});

test("the API refuses the child-process subject at startup, before it listens", () => {
	const server = fileURLToPath(new URL("../../../apps/api/src/server.ts", import.meta.url));
	// A non-dev boot needs a registry whose cases are not the public example. The test fixture stands in.
	const registry = join(mkdtempSync(join(tmpdir(), "acquit-api-subject-")), "fixtures.json");
	writeFileSync(registry, JSON.stringify({ version: 1, fixtures: [{
		repository: "maya-client/invoice-app", issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" },
		frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4", frozenTestPath: "tests/totals.test.ts",
		visible: 48, hidden: 6, hiddenIdPrefix: "hidden",
		protectedPaths: ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"],
		hiddenCases: fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.test.json", import.meta.url)),
		frozenExtractor: "invoice-totals", demoForkPrefix: "acquit-forks/" }] }), { mode: 0o600 });
	const child = spawnSync(process.execPath, [server], { encoding: "utf8", timeout: 15_000,
		env: { ...process.env, ACQUIT_VERIFIER_SUBJECT: "child", ACQUIT_DEV: "0", ACQUIT_FIXTURES: registry, PORT: "0" } });
	assert.equal(child.status, 1);
	assert.match(child.stderr, /SUBJECT_CHILD_REFUSED/);
	assert.equal(child.stderr.includes("Acquit API:"), false);
});
