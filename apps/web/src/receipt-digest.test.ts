import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, digestOfHiddenCases, type DigestCase } from "./receipt-digest.ts";

// The same two cases and salt the API's public-receipt test serves. Both digests were produced by the
// core's digestOfHiddenCases (packages/core/src/hidden-seal.ts), so this file proves the browser's
// Web Crypto recomputation matches the server's seal byte for byte.
const SALT = "5a".repeat(32);
const cases: readonly DigestCase[] = [
	{ id: "per-job-1", target: { module: "src/invoice.ts", export: "totalOf" }, args: [[]], expected: 0 },
	{ id: "per-job-2", target: { module: "src/invoice.ts", export: "totalOf" }, args: [[-2, 5]], expected: 3 },
];
const CORE_DIGEST = "1764db63ab48ebab5142bfc8275d72ba1b09672157ed55433394445c025bf5a7";
const TAMPERED_DIGEST = "54842b81de0e36a4b6cd715776f339b52f76ca88af06637e219d5747b64f0485";

test("the canonical JSON sorts object keys at every depth and leaves array order alone", () => {
	assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }] }), '{"a":[{"c":null,"d":2}],"b":1}');
	assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("the browser digest of the revealed cases equals the digest the core sealed", async () => {
	assert.equal(await digestOfHiddenCases(cases, SALT), CORE_DIGEST);
});

test("a tampered case recomputes to a different digest, so the page reports no match", async () => {
	const tampered: readonly DigestCase[] = [cases[0]!, { ...cases[1]!, expected: 4 }];
	const digest = await digestOfHiddenCases(tampered, SALT);
	assert.equal(digest, TAMPERED_DIGEST);
	assert.notEqual(digest, CORE_DIGEST);
});

test("a salt that is not 32 bytes of lowercase hex is refused before any digest is computed", async () => {
	await assert.rejects(digestOfHiddenCases(cases, "not-a-salt"), /32 bytes of lowercase hex/);
	await assert.rejects(digestOfHiddenCases(cases, SALT.toUpperCase()), /32 bytes of lowercase hex/);
});
