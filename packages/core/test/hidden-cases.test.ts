// K1. The hidden cases live in a per-fixture private file, never in the repo and never on the
// subject's mounts. This file pins the boundary: the parser refuses every malformed manifest by
// name, a non-dev process without a registry refuses to start, the core fixture module holds no
// cases, and the Docker subject mounts only the tree and the bootstrap.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Digest, TestId } from "../src/ids.ts";
import * as seedData from "../src/seed-data.ts";
import { manifestOf } from "../src/fixtures.ts";
import type { HiddenContract } from "../src/fixtures.ts";
import { EXAMPLE_HIDDEN_CASES_PATH, EXAMPLE_HIDDEN_CASE_SHAPE, hiddenContractOf, loadExampleHiddenCases, loadHiddenCasesFromFile, parseHiddenCases } from "../../verifier/hidden.ts";
import { buildFixtureBook, EXAMPLE_FIXTURES_PATH, FIXTURES_ENV, fixtureContracts, fixtureRegistrySource, loadFixtureRegistry } from "../../verifier/fixtures.ts";
import { FixtureConfigError } from "../src/fixtures.ts";
import { dockerArgs } from "../../verifier/subject.ts";
import { bootLine } from "../../verifier/server.ts";
import { demoFixture } from "./hidden-fixture.ts";

/** A well-formed case in the manifest's own shape. The values are fixtures; the deployment's own file is never in the repo. */
const sampleCase = (index: number) => ({ id: `hidden:${index}`, target: { module: "src/money.ts", export: "formatTotal" },
	args: [[{ amount: 1.5 }], "USD"], expected: "1.50" });
/** The laptop store's path: the deployment default, and what ACQUIT_PRIVATE_CASES overrides. */
const DEFAULT_PRIVATE_CASES_PATH = "/home/factory-user/.config/acquit/private/hidden-cases.json";
/** The deployment's private case file: ACQUIT_PRIVATE_CASES when set, resolved to an absolute
 * path against the process cwd (a VM's registry names its own files under /var/lib/acquit), else
 * the laptop store. Mode 0600 under its own store, outside every git repository; its expected
 * values are never printed. The private-file tests skip when the store is absent, never pass
 * vacuously. */
function privateCasesPath(env: Record<string, string | undefined> = process.env): string {
	const configured = env.ACQUIT_PRIVATE_CASES?.trim();
	return configured ? resolve(configured) : DEFAULT_PRIVATE_CASES_PATH;
}
const PRIVATE_CASES_PATH = privateCasesPath();
/** The non-dev test fixture: its own cases, so a non-dev boot never runs on the public example. */
const TEST_HIDDEN_CASES_PATH = fileURLToPath(new URL("../../verifier/fixtures/hidden-cases.test.json", import.meta.url));
const SHAPE = EXAMPLE_HIDDEN_CASE_SHAPE;
/** The non-dev test file's own shape: six cases, none of them the public example's. */
const TEST_SHAPE = { count: 6, idPrefix: "hidden" };
const eight = () => Array.from({ length: 8 }, (_, index) => sampleCase(index + 1));
const manifest = (cases: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, cases, ...extra });
const invalid = (text: string, what: string) => {
	assert.throws(() => parseHiddenCases(text, "(test file)", SHAPE), (error: unknown) => {
		assert.ok(error instanceof Error, `${what} did not refuse`);
		assert.match(error.message, /^Invalid configuration: hidden-case file\./, `${what} refused as ${error.message}`);
		return true;
	});
};

test("the core fixture module holds no hidden cases", () => {
	assert.equal("HIDDEN_CASES" in seedData, false);
	assert.equal("hiddenManifest" in seedData, false);
	assert.equal("frozenDefinition" in seedData, false);
});

test("the verifier boot line names the fixture registry path", () => {
	const named = "/var/lib/acquit/fixtures.json";
	assert.equal(fixtureRegistrySource({ ACQUIT_FIXTURES: named, ACQUIT_DEV: "0" }), named);
	assert.equal(fixtureRegistrySource({ ACQUIT_FIXTURES: "  ", ACQUIT_DEV: "1" }), EXAMPLE_FIXTURES_PATH);
	assert.ok(bootLine(4311, "docker", named, []).includes(named), "the boot line names the registry path");
});

test("the committed example parses to the eight public cases, the last two negative", () => {
	const cases = loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH, SHAPE);
	assert.deepEqual(cases.map(entry => entry.id), ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6", "hidden:7", "hidden:8"]);
	for (const entry of cases) assert.deepEqual(entry.target, { module: "src/money.ts", export: "formatTotal" });
	assert.equal(new Set(cases.map(entry => JSON.stringify(entry))).size, 8);
	assert.deepEqual(cases.slice(6).map(entry => entry.expected), ["-1.234", "-6.00"]);
});

test("the parser refuses every malformed manifest by name", () => {
	invalid("{", "unparsable JSON");
	invalid(JSON.stringify([1, 2]), "a JSON array");
	invalid(manifest(eight(), { extra: true }), "an unknown top-level field");
	invalid(JSON.stringify({ cases: eight() }), "a missing version");
	invalid(manifest(eight(), { version: 2 }), "an unknown version");
	invalid(manifest("nope"), "a non-array cases field");
	invalid(manifest(eight().slice(0, 7)), "seven cases");
	invalid(manifest([...eight(), sampleCase(9)]), "nine cases");
	invalid(manifest([...eight().slice(0, 7), "nope"]), "a non-object case");
	invalid(manifest(eight().map((entry, index) => index === 2 ? { ...entry, surprise: 1 } : entry)), "an unknown case field");
	invalid(manifest([sampleCase(1), sampleCase(1), ...eight().slice(2)]), "a duplicate id");
	invalid(manifest([{ ...sampleCase(1), id: "hidden:0" }, ...eight().slice(1)]), "a zero id");
	invalid(manifest([{ ...sampleCase(1), id: "visible:1" }, ...eight().slice(1)]), "an id from another suite");
	invalid(manifest([...eight().slice(0, 7), { ...sampleCase(8), id: "hidden:9" }]), "an id past the count");
	invalid(manifest([{ ...sampleCase(1), target: { module: "src/money.ts" } }, ...eight().slice(1)]), "a target without an export");
	invalid(manifest([{ ...sampleCase(1), target: { module: "", export: "formatTotal" } }, ...eight().slice(1)]), "an empty module");
	invalid(manifest([{ ...sampleCase(1), args: "1.50" }, ...eight().slice(1)]), "args that are not an array");
	invalid(manifest([{ ...sampleCase(1), expected: undefined }, ...eight().slice(1)]), "a missing expected value");
	invalid(manifest([{ ...sampleCase(1), args: [[{ amount: "x".repeat(9_000) }], "USD"] }, ...eight().slice(1)]), "a case past the subject frame limit");
});

test("key order in the file never changes the contract digest", () => {
	const reordered = eight().map(entry => ({ expected: entry.expected, args: entry.args, target: entry.target, id: entry.id }));
	assert.equal(hiddenContractOf(parseHiddenCases(manifest(reordered), "(a)", SHAPE)).digest,
		hiddenContractOf(parseHiddenCases(manifest(eight()), "(b)", SHAPE)).digest);
	assert.notEqual(hiddenContractOf(parseHiddenCases(manifest(eight().map((entry, index) => index === 0 ? { ...entry, expected: "1.51" } : entry)), "(c)", SHAPE)).digest,
		hiddenContractOf(parseHiddenCases(manifest(eight()), "(d)", SHAPE)).digest);
});

/** A registry beside its own case file: the given case text is written as the entry's hiddenCases. */
function registryFor(caseText: string, overrides: Record<string, unknown> = {}): string {
	const entry = { repository: "maya-client/invoice-app", issue: { number: 12, title: "Totals" },
		frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4", frozenTestPath: "tests/totals.test.ts",
		visible: 48, hidden: 6, protectedPaths: ["tests/**"], hiddenCases: "hidden-cases.json", frozenExtractor: "invoice-totals", ...overrides };
	const dir = mkdtempSync(join(tmpdir(), "acquit-fixtures-registry-"));
	const path = join(dir, "fixtures.json");
	writeFileSync(path, JSON.stringify({ version: 1, fixtures: [entry] }), { mode: 0o600 });
	writeFileSync(join(dir, "hidden-cases.json"), caseText, { mode: 0o600 });
	return path;
}

test("a non-dev process without a registry refuses by name", () => {
	for (const env of [{}, { ACQUIT_DEV: "0" }]) {
		assert.throws(() => loadFixtureRegistry(env), (error: unknown) => {
			assert.ok(error instanceof FixtureConfigError);
			assert.equal(error.code, "FIXTURES_CONFIG_MISSING");
			assert.deepEqual(error.names, [FIXTURES_ENV]);
			return true;
		});
	}
	assert.throws(() => loadFixtureRegistry({ ACQUIT_FIXTURES: "fixtures.json" }), (error: unknown) => {
		assert.ok(error instanceof FixtureConfigError);
		assert.equal(error.code, "FIXTURES_CONFIG_INVALID");
		assert.deepEqual(error.names, [FIXTURES_ENV]);
		return true;
	});
	// A development process falls back to the committed example registry, and it alone.
	const dev = loadFixtureRegistry({ ACQUIT_DEV: "1" });
	assert.equal(dev.path, EXAMPLE_FIXTURES_PATH);
	assert.deepEqual(dev.entries.map(entry => entry.repository), ["maya-client/invoice-app"]);
	assert.deepEqual(fixtureContracts(dev).map(entry => entry.hiddenManifest), [hiddenContractOf(loadExampleHiddenCases()).digest]);
});

test("the registry names the case files, and those files alone decide the contracts", () => {
	const altered = manifest(eight().map((entry, index) => index === 0 ? { ...entry, expected: "9.99" } : entry));
	const registryPath = registryFor(altered, { hidden: 8 });
	const registry = loadFixtureRegistry({ ACQUIT_FIXTURES: registryPath });
	const book = buildFixtureBook(registry);
	const loaded = loadHiddenCasesFromFile(join(dirname(registryPath), "hidden-cases.json"), SHAPE);
	assert.deepEqual([...book.byDigest.keys()], [hiddenContractOf(loaded).digest]);
	assert.notEqual(hiddenContractOf(loaded).digest, hiddenContractOf(loadExampleHiddenCases()).digest);
	assert.deepEqual(fixtureContracts(registry).map(entry => entry.hiddenManifest), [hiddenContractOf(loaded).digest]);
});

test("a non-dev registry refuses the committed public example, and a dev one may name it", () => {
	assert.throws(() => buildFixtureBook(loadFixtureRegistry({ ACQUIT_FIXTURES: EXAMPLE_FIXTURES_PATH }), {}), (error: unknown) => {
		assert.ok(error instanceof FixtureConfigError, "the public example did not refuse with a config error");
		assert.equal(error.code, "FIXTURES_CONFIG_INVALID");
		assert.deepEqual(error.names, [FIXTURES_ENV]);
		assert.match(error.message, /public example/);
		return true;
	});
	const devRegistry = loadFixtureRegistry({ ACQUIT_FIXTURES: EXAMPLE_FIXTURES_PATH, ACQUIT_DEV: "1" });
	const dev = buildFixtureBook(devRegistry, { ACQUIT_DEV: "1" });
	assert.deepEqual([...dev.byDigest.keys()], [hiddenContractOf(loadExampleHiddenCases()).digest]);
	// The non-dev test fixture is never mistaken for the public example: a registry naming it loads.
	const test = buildFixtureBook(loadFixtureRegistry({ ACQUIT_FIXTURES: registryFor(
		readFileSync(TEST_HIDDEN_CASES_PATH, "utf8")) }));
	assert.deepEqual([...test.byDigest.keys()], [hiddenContractOf(loadHiddenCasesFromFile(TEST_HIDDEN_CASES_PATH, TEST_SHAPE)).digest]);
});

test("manifestOf stores the contract it is handed", () => {
	const contract: HiddenContract = { ids: ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6"].map(id => id as TestId),
		digest: "ab".repeat(32) as Digest };
	const done = manifestOf(demoFixture(contract), "owner/repo");
	assert.equal(done.hiddenManifest, contract.digest);
	assert.deepEqual(done.hiddenTests, contract.ids);
	assert.equal(done.issue.repository, "owner/repo");
	assert.notEqual(done.hiddenManifest, hiddenContractOf(loadExampleHiddenCases()).digest);
});

test("the Docker subject mounts only the submitted tree and the bootstrap", () => {
	const args = dockerArgs("/tmp/tree", "acquit/runner-node20:latest", "acquit-subject-1", "/tmp/bootstrap.ts", "/tmp/container.cid");
	const mounts = args.filter((arg, index) => args[index - 1] === "--mount");
	assert.equal(mounts.length, 2);
	assert.deepEqual(mounts.map(mount => mount.slice(0, mount.indexOf(",target="))), ["type=bind,source=/tmp/tree", "type=bind,source=/tmp/bootstrap.ts"]);
	assert.deepEqual(mounts.map(mount => mount.slice(mount.indexOf(",target="))), [",target=/tree,readonly", ",target=/runner/bootstrap.ts,readonly"]);
	assert.equal(args.some(arg => arg.includes(EXAMPLE_HIDDEN_CASES_PATH)), false);
});

test("the verifier service refuses to start without a fixture registry", () => {
	const server = fileURLToPath(new URL("../../verifier/server.ts", import.meta.url));
	const child = spawnSync(process.execPath, [server], { encoding: "utf8", timeout: 15_000,
		env: { ...process.env, ACQUIT_DEV: "0", ACQUIT_FIXTURES: "", ACQUIT_VERIFIER_PORT: "4399",
			ACQUIT_VERIFIER_RUN_SECRET: "run-secret", ACQUIT_VERIFIER_CALLBACK_SECRET: "callback-secret",
			ACQUIT_VERIFIER_CALLBACK_URL: "http://127.0.0.1:4398/api/verifier/callback" } });
	assert.equal(child.status, 1);
	assert.match(child.stderr, /FIXTURES_CONFIG_MISSING/);
	assert.match(child.stderr, new RegExp(FIXTURES_ENV));
});

// The lever walks every tracked file and prints counts only. On the committed example it must find
// the values, which is what proves the check can see them; on a deployment's private file it must
// find none. The private file is gitignored, so its absence is a skip, never a pass.
const checkScript = fileURLToPath(new URL("../../../scripts/check-hidden-private.mjs", import.meta.url));
const lever = (manifestPath: string, root?: string) => spawnSync(process.execPath, [checkScript, manifestPath, ...(root ? [root] : [])],
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
	const cases = loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH, SHAPE);
	const source = `const copiedCases = [\n${cases.map(entry => `  {\n    id: ${JSON.stringify(entry.id)},\n    target: ${JSON.stringify(entry.target)},\n    args: ${JSON.stringify(entry.args)},\n    expected: ${JSON.stringify(entry.expected)},\n  },`).join("\n")}\n];\n`;
	const dir = copiedRepo({ "copied-cases.ts": source });
	try {
		const result = lever(EXAMPLE_HIDDEN_CASES_PATH, dir);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /cases=8 files=1 total=8/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the check script sees a case spread across lines in a pretty-printed JSON copy", () => {
	const copy = JSON.stringify({ version: 1, cases: loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH, SHAPE) }, null, 2);
	const dir = copiedRepo({ "copied-cases.json": copy });
	try {
		const result = lever(EXAMPLE_HIDDEN_CASES_PATH, dir);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /cases=8 files=1 total=8/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the check script finds the public example in the repository", () => {
	const result = lever(EXAMPLE_HIDDEN_CASES_PATH);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, /cases=8 files=\d+ total=[1-9]\d*/);
});

test("the check script finds nothing from a deployment's private file", { skip: existsSync(PRIVATE_CASES_PATH) ? false : "No private case file in this checkout; set ACQUIT_PRIVATE_CASES or provision the store." }, () => {
	const result = lever(PRIVATE_CASES_PATH);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /cases=8 files=\d+ total=0/);
	assert.deepEqual(loadHiddenCasesFromFile(PRIVATE_CASES_PATH, SHAPE).map(entry => entry.id), ["hidden:1", "hidden:2", "hidden:3", "hidden:4", "hidden:5", "hidden:6", "hidden:7", "hidden:8"]);
	assert.notEqual(hiddenContractOf(loadHiddenCasesFromFile(PRIVATE_CASES_PATH, SHAPE)).digest, hiddenContractOf(loadExampleHiddenCases()).digest);
});

/** Every directory above the store's, including the filesystem root itself: a store under a
 * repository mounted at the root is still caught. The walk stops at the first directory that is
 * its own parent, the root, so a relative start cannot spin on dirname('.') === '.'. */
function ancestorsAbove(start: string): string[] {
	const dirs: string[] = [];
	for (let dir = dirname(start); ; dir = dirname(dir)) { dirs.push(dir); if (dirname(dir) === dir) break; }
	return dirs;
}
/** A work tree's .git entry, or a bare repository's HEAD plus objects/ pair. */
function isGitRepository(dir: string): boolean {
	return existsSync(join(dir, ".git")) || (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects")));
}

test("the deployment's private case file sits outside every git repository", { skip: existsSync(PRIVATE_CASES_PATH) ? false : "No private case file in this deployment; set ACQUIT_PRIVATE_CASES or provision the store." }, () => {
	for (const dir of ancestorsAbove(PRIVATE_CASES_PATH)) {
		assert.ok(!isGitRepository(dir), `${dir} holds a git repository; the private case store must not`);
	}
});

test("the ancestor walk reaches the filesystem root itself", () => {
	const store = join(tmpdir(), "deep", "path", "hidden-cases.json");
	assert.ok(ancestorsAbove(store).includes(parse(store).root),
		"the walk stopped before the filesystem root; a store under a repository mounted at the root would slip past it");
});

test("the ancestor walk detects a bare repository above the store", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-hidden-bare-"));
	try {
		writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
		mkdirSync(join(root, "objects"), { recursive: true });
		assert.deepEqual(ancestorsAbove(join(root, "store", "hidden-cases.json")).filter(isGitRepository), [root],
			"a bare repository (HEAD plus objects, no .git) above the store went undetected");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a directory holding only HEAD or only objects is not a bare repository", () => {
	const root = mkdtempSync(join(tmpdir(), "acquit-hidden-notbare-"));
	try {
		writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
		assert.equal(isGitRepository(root), false, "HEAD alone is not a bare repository marker");
		rmSync(join(root, "HEAD"));
		mkdirSync(join(root, "objects"), { recursive: true });
		assert.equal(isGitRepository(root), false, "objects alone is not a bare repository marker");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a relative ACQUIT_PRIVATE_CASES terminates", () => {
	const store = mkdtempSync(join(tmpdir(), "acquit-hidden-rel-"));
	try {
		mkdirSync(join(store, "private"), { recursive: true });
		writeFileSync(join(store, "private", "hidden-cases.json"), manifest(eight()), { mode: 0o600 });
		// The child runs the actual walk test above, unisolated, with the knob relative to that cwd.
		// The heap cap makes a regressed walk abort in seconds instead of pinning the machine, and
		// the spawn timeout is the backstop; the pass-1 match refuses a child that skipped the test.
		const result = spawnSync(process.execPath,
			["--test", "--test-isolation=none", "--max-old-space-size=256", "--test-name-pattern=sits outside every git repository",
				fileURLToPath(new URL("./hidden-cases.test.ts", import.meta.url))],
			{ cwd: store, env: { ...process.env, ACQUIT_PRIVATE_CASES: "private/hidden-cases.json" }, encoding: "utf8", timeout: 20_000 });
		assert.equal(result.status, 0, `the relative-path run ended in ${result.signal ?? result.status}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /\bpass 1\b/, "the walk test itself must have run once");
	} finally { rmSync(store, { recursive: true, force: true }); }
});

test("the private-case path honors its environment knob", () => {
	assert.equal(privateCasesPath({}), DEFAULT_PRIVATE_CASES_PATH, "no knob value keeps the laptop default");
	assert.equal(privateCasesPath({ ACQUIT_PRIVATE_CASES: "/var/lib/acquit/private/hidden-cases.json" }), resolve("/var/lib/acquit/private/hidden-cases.json"),
		"the knob names the deployment's own store");
	assert.equal(privateCasesPath({ ACQUIT_PRIVATE_CASES: "  " }), DEFAULT_PRIVATE_CASES_PATH, "a blank knob value keeps the default");
	assert.equal(isAbsolute(privateCasesPath({ ACQUIT_PRIVATE_CASES: "private/hidden-cases.json" })), true, "a relative knob value resolves to an absolute path");
});
