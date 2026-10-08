// K1. The hidden cases live in a per-deployment private file, never in the repo and never on the
// subject's mounts. This file pins the boundary: the parser refuses every malformed manifest by
// name, a non-dev process without the environment refuses to start, the core fixture module holds no
// cases, and the Docker subject mounts only the tree and the bootstrap.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Digest, TestId } from "../src/ids.ts";
import * as seedData from "../src/seed-data.ts";
import type { HiddenContract } from "../src/seed-data.ts";
import { VerifierConfigError } from "../../verifier/config.ts";
import { EXAMPLE_HIDDEN_CASES_PATH, HIDDEN_CASES_ENV, hiddenContractOf, loadHiddenCases, loadHiddenCasesFromFile, parseHiddenCases } from "../../verifier/hidden.ts";
import { dockerArgs } from "../../verifier/subject.ts";

/** A well-formed case in the manifest's own shape. The values are fixtures; the deployment's own file is never in the repo. */
const sampleCase = (index: number) => ({ id: `hidden:${index}`, target: { module: "src/money.ts", export: "formatTotal" },
	args: [[{ amount: 1.5 }], "USD"], expected: "1.50" });
/** The K1 live-proof deployment file, written 0600 and gitignored. Its expected values are never printed. */
const PRIVATE_CASES_PATH = fileURLToPath(new URL("../../../data/private/hidden-cases.json", import.meta.url));
/** The non-dev test fixture: its own cases, so a non-dev boot never runs on the public example. */
const TEST_HIDDEN_CASES_PATH = fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.test.json", import.meta.url));
const six = () => Array.from({ length: 6 }, (_, index) => sampleCase(index + 1));
const manifest = (cases: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, cases, ...extra });
const invalid = (text: string, what: string) => {
	assert.throws(() => parseHiddenCases(text), (error: unknown) => {
		assert.ok(error instanceof VerifierConfigError, `${what} did not refuse with a config error`);
		assert.equal(error.code, "VERIFIER_CONFIG_INVALID", `${what} refused with ${error.code}`);
		assert.deepEqual(error.names, [HIDDEN_CASES_ENV], `${what} did not name ${HIDDEN_CASES_ENV}`);
		return true;
	});
};

test("the core fixture module holds no hidden cases", () => {
	assert.equal("HIDDEN_CASES" in seedData, false);
	assert.equal("hiddenManifest" in seedData, false);
});

test("the committed example parses to the six public cases", () => {
	const cases = loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH);
	assert.deepEqual(cases.map(test => test.id), ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6"]);
	for (const test of cases) assert.deepEqual(test.target, { module: "src/money.ts", export: "formatTotal" });
	assert.equal(new Set(cases.map(test => JSON.stringify(test))).size, 6);
});

test("the parser refuses every malformed manifest by name", () => {
	invalid("{", "unparsable JSON");
	invalid(JSON.stringify([1, 2]), "a JSON array");
	invalid(manifest(six(), { extra: true }), "an unknown top-level field");
	invalid(JSON.stringify({ cases: six() }), "a missing version");
	invalid(manifest(six(), { version: 2 }), "an unknown version");
	invalid(manifest("nope"), "a non-array cases field");
	invalid(manifest(six().slice(0, 5)), "five cases");
	invalid(manifest([...six(), sampleCase(7)]), "seven cases");
	invalid(manifest([...six().slice(0, 5), "nope"]), "a non-object case");
	invalid(manifest(six().map((entry, index) => index === 2 ? { ...entry, surprise: 1 } : entry)), "an unknown case field");
	invalid(manifest([sampleCase(1), sampleCase(1), ...six().slice(2)]), "a duplicate id");
	invalid(manifest([{ ...sampleCase(1), id: "hidden:0" }, ...six().slice(1)]), "a zero id");
	invalid(manifest([{ ...sampleCase(1), id: "visible:1" }, ...six().slice(1)]), "an id from another suite");
	invalid(manifest([...six().slice(0, 5), { ...sampleCase(6), id: "hidden:7" }]), "an id past the count");
	invalid(manifest([{ ...sampleCase(1), target: { module: "src/money.ts" } }, ...six().slice(1)]), "a target without an export");
	invalid(manifest([{ ...sampleCase(1), target: { module: "", export: "formatTotal" } }, ...six().slice(1)]), "an empty module");
	invalid(manifest([{ ...sampleCase(1), args: "1.50" }, ...six().slice(1)]), "args that are not an array");
	invalid(manifest([{ ...sampleCase(1), expected: undefined }, ...six().slice(1)]), "a missing expected value");
	invalid(manifest([{ ...sampleCase(1), args: [[{ amount: "x".repeat(9_000) }], "USD"] }, ...six().slice(1)]), "a case past the subject frame limit");
});

test("key order in the file never changes the contract digest", () => {
	const reordered = six().map(entry => ({ expected: entry.expected, args: entry.args, target: entry.target, id: entry.id }));
	assert.equal(hiddenContractOf(parseHiddenCases(manifest(reordered))).digest, hiddenContractOf(parseHiddenCases(manifest(six()))).digest);
	assert.notEqual(hiddenContractOf(parseHiddenCases(manifest(six().map((entry, index) => index === 0 ? { ...entry, expected: "1.51" } : entry)))).digest,
		hiddenContractOf(parseHiddenCases(manifest(six()))).digest);
});

test("a non-dev process without the environment refuses by name", () => {
	for (const env of [{}, { ACQUIT_DEV: "0" }]) {
		assert.throws(() => loadHiddenCases(env), (error: unknown) => {
			assert.ok(error instanceof VerifierConfigError);
			assert.equal(error.code, "VERIFIER_CONFIG_MISSING");
			assert.deepEqual(error.names, [HIDDEN_CASES_ENV]);
			return true;
		});
	}
	assert.throws(() => loadHiddenCases({ ACQUIT_HIDDEN_CASES: "hidden.json" }), (error: unknown) => {
		assert.ok(error instanceof VerifierConfigError);
		assert.equal(error.code, "VERIFIER_CONFIG_INVALID");
		assert.deepEqual(error.names, [HIDDEN_CASES_ENV]);
		return true;
	});
	const dev = loadHiddenCases({ ACQUIT_DEV: "1" });
	assert.deepEqual(dev.map(test => test.id), loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH).map(test => test.id));
});

test("the environment names a file, and that file alone decides the contract", () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-hidden-cases-"));
	try {
		const path = join(dir, "hidden-cases.json");
		writeFileSync(path, manifest(six().map((entry, index) => index === 0 ? { ...entry, expected: "9.99" } : entry)), { mode: 0o600 });
		const loaded = loadHiddenCases({ ACQUIT_HIDDEN_CASES: path });
		assert.deepEqual(loaded.map(test => test.id), ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6"]);
		assert.notEqual(hiddenContractOf(loaded).digest, hiddenContractOf(loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH)).digest);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a non-dev process refuses the committed public example by name, even as a copy or a symlink", () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-hidden-example-"));
	try {
		// A copy whose key order and whitespace differ still parses to the example's contract.
		const reordered = join(dir, "reordered-example.json");
		writeFileSync(reordered, JSON.stringify({ version: 1, cases: loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH)
			.map(entry => ({ expected: entry.expected, args: entry.args, target: entry.target, id: entry.id })) }, null, 2), { mode: 0o600 });
		const linked = join(dir, "linked-example.json");
		symlinkSync(EXAMPLE_HIDDEN_CASES_PATH, linked);
		for (const path of [EXAMPLE_HIDDEN_CASES_PATH, reordered, linked]) {
			for (const env of [{ ACQUIT_HIDDEN_CASES: path }, { ACQUIT_DEV: "0", ACQUIT_HIDDEN_CASES: path }]) {
				assert.throws(() => loadHiddenCases(env), (error: unknown) => {
					assert.ok(error instanceof VerifierConfigError, `${path} did not refuse with a config error`);
					assert.equal(error.code, "VERIFIER_CONFIG_INVALID", `${path} refused with ${error.code}`);
					assert.deepEqual(error.names, [HIDDEN_CASES_ENV]);
					assert.match(error.message, /public example/);
					return true;
				});
			}
		}
		// A development process may name the example, and the non-dev test fixture is never mistaken for it.
		assert.deepEqual(loadHiddenCases({ ACQUIT_DEV: "1", ACQUIT_HIDDEN_CASES: EXAMPLE_HIDDEN_CASES_PATH }).map(entry => entry.id),
			loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH).map(entry => entry.id));
		const fixture = loadHiddenCases({ ACQUIT_HIDDEN_CASES: TEST_HIDDEN_CASES_PATH });
		assert.deepEqual(fixture.map(entry => entry.id), ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6"]);
		assert.notEqual(hiddenContractOf(fixture).digest, hiddenContractOf(loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH)).digest);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("frozenDefinition stores the contract it is handed", () => {
	const contract: HiddenContract = { ids: ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6"].map(id => id as TestId),
		digest: "ab".repeat(32) as Digest };
	const done = seedData.frozenDefinition("owner/repo", contract);
	assert.equal(done.hiddenManifest, contract.digest);
	assert.deepEqual(done.hiddenTests, contract.ids);
	assert.equal(done.issue.repository, "owner/repo");
	assert.notEqual(done.hiddenManifest, hiddenContractOf(loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH)).digest);
});

test("the Docker subject mounts only the submitted tree and the bootstrap", () => {
	const args = dockerArgs("/tmp/tree", "acquit/runner-node20:latest", "acquit-subject-1", "/tmp/bootstrap.ts", "/tmp/container.cid");
	const mounts = args.filter((arg, index) => args[index - 1] === "--mount");
	assert.equal(mounts.length, 2);
	assert.deepEqual(mounts.map(mount => mount.slice(0, mount.indexOf(",target="))), ["type=bind,source=/tmp/tree", "type=bind,source=/tmp/bootstrap.ts"]);
	assert.deepEqual(mounts.map(mount => mount.slice(mount.indexOf(",target="))), [",target=/tree,readonly", ",target=/runner/bootstrap.ts,readonly"]);
	assert.equal(args.some(arg => arg.includes(EXAMPLE_HIDDEN_CASES_PATH)), false);
});

test("the verifier service refuses to start without the deployment's cases", () => {
	const server = fileURLToPath(new URL("../../verifier/server.ts", import.meta.url));
	const child = spawnSync(process.execPath, [server], { encoding: "utf8", timeout: 15_000,
		env: { ...process.env, ACQUIT_DEV: "0", ACQUIT_HIDDEN_CASES: "", ACQUIT_VERIFIER_PORT: "4399",
			ACQUIT_VERIFIER_RUN_SECRET: "run-secret", ACQUIT_VERIFIER_CALLBACK_SECRET: "callback-secret",
			ACQUIT_VERIFIER_CALLBACK_URL: "http://127.0.0.1:4398/api/verifier/callback" } });
	assert.equal(child.status, 1);
	assert.match(child.stderr, /VERIFIER_CONFIG_MISSING/);
	assert.match(child.stderr, new RegExp(HIDDEN_CASES_ENV));
});

// The lever walks every tracked file and prints counts only. On the committed example it must find
// the values, which is what proves the check can see them; on a deployment's private file it must
// find none. The private file is gitignored, so its absence is a skip, never a pass.
const checkScript = fileURLToPath(new URL("../../../scripts/check-hidden-private.mjs", import.meta.url));
const lever = (manifest: string, root?: string) => spawnSync(process.execPath, [checkScript, manifest, ...(root ? [root] : [])],
	{ encoding: "utf8", timeout: 120_000 });
/** A throwaway git repo whose tracked files are the given name-to-text pairs. */
function copiedRepo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "acquit-hidden-copy-"));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { mode: 0o600 });
	execFileSync("git", ["-C", dir, "init", "-q"]);
	execFileSync("git", ["-C", dir, "add", "-A"]);
	return dir;
}

test("the check script sees a case spread across lines in a source copy", () => {
	const cases = loadHiddenCasesFromFile(TEST_HIDDEN_CASES_PATH);
	const source = `const copiedCases = [\n${cases.map(entry => `  {\n    id: ${JSON.stringify(entry.id)},\n    target: ${JSON.stringify(entry.target)},\n    args: ${JSON.stringify(entry.args)},\n    expected: ${JSON.stringify(entry.expected)},\n  },`).join("\n")}\n];\n`;
	const dir = copiedRepo({ "copied-cases.ts": source });
	try {
		const result = lever(TEST_HIDDEN_CASES_PATH, dir);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /cases=6 files=1 total=6/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the check script sees a case spread across lines in a pretty-printed JSON copy", () => {
	const copy = JSON.stringify({ version: 1, cases: loadHiddenCasesFromFile(TEST_HIDDEN_CASES_PATH) }, null, 2);
	const dir = copiedRepo({ "copied-cases.json": copy });
	try {
		const result = lever(TEST_HIDDEN_CASES_PATH, dir);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /cases=6 files=1 total=6/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the check script finds the public example in the repository", () => {
	const result = lever(EXAMPLE_HIDDEN_CASES_PATH);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, /cases=6 files=\d+ total=[1-9]\d*/);
});

test("the check script finds nothing from a deployment's private file", { skip: existsSync(PRIVATE_CASES_PATH) ? false : "No private case file in this checkout." }, () => {
	const result = lever(PRIVATE_CASES_PATH);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /cases=6 files=\d+ total=0/);
	assert.deepEqual(loadHiddenCasesFromFile(PRIVATE_CASES_PATH).map(entry => entry.id), ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6"]);
	assert.notEqual(hiddenContractOf(loadHiddenCasesFromFile(PRIVATE_CASES_PATH)).digest, hiddenContractOf(loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH)).digest);
	// The deployment's own file is the allowed path through the environment policy, not the example.
	assert.deepEqual(loadHiddenCases({ ACQUIT_HIDDEN_CASES: PRIVATE_CASES_PATH }).map(entry => entry.id),
		["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6"]);
});
