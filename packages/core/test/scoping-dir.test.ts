// The scoping store's location. The default is the deployment's private store — the one the M1
// private case files already live in (~/.config/acquit/private) — in a per-database subdirectory
// so lanes never collide; never beside the database, which for a local or lane run sits inside a
// gitignored worktree, and a repository is exactly where private case files must not live. The
// ACQUIT_SCOPING_DIR override names the directory outright (the VM pins /var/lib/acquit/scoping
// this way), and a default that would resolve inside a git work tree refuses by name.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveScopingDir } from "../src/scoping-dir.ts";

const cleanUp = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

test("the default is the private store's per-database subdirectory, never beside the database", () => {
	const home = mkdtempSync(join(tmpdir(), "acquit-scoping-home-"));
	try {
		const dbPath = join(home, "worktree", "data", "verify", "lane-50", "acquit.db");
		const resolved = resolveScopingDir({ HOME: home, DATABASE_PATH: dbPath });
		const privateStore = join(home, ".config", "acquit", "private", "scoping");
		assert.ok(resolved.startsWith(`${privateStore}/`), `${resolved} must sit under the private store ${privateStore}`);
		assert.ok(!resolved.startsWith(join(dbPath, "..")), "the store never sits beside the database: for a lane that is inside the worktree");
	} finally { cleanUp(home); }
});

test("two databases never share a store, and one database always resolves to the same store", () => {
	const home = mkdtempSync(join(tmpdir(), "acquit-scoping-keys-"));
	try {
		const lane50 = { HOME: home, DATABASE_PATH: join(home, "lane-50", "acquit.db") };
		const lane51 = { HOME: home, DATABASE_PATH: join(home, "lane-51", "acquit.db") };
		assert.notEqual(resolveScopingDir(lane50), resolveScopingDir(lane51), "two lanes' databases never collide in the store");
		assert.equal(resolveScopingDir(lane50), resolveScopingDir(lane50), "the same database resolves to the same store: the API's park is the verifier's book");
	} finally { cleanUp(home); }
});

test("the explicit override still names the directory outright, wherever it points", () => {
	assert.equal(resolveScopingDir({ ACQUIT_SCOPING_DIR: "/var/lib/acquit/scoping", HOME: "/elsewhere" }), "/var/lib/acquit/scoping");
});

test("the config root follows XDG_CONFIG_HOME when it is set", () => {
	const resolved = resolveScopingDir({ XDG_CONFIG_HOME: "/xdg-config", HOME: "/home/x", DATABASE_PATH: "/db/acquit.db" });
	assert.ok(resolved.startsWith("/xdg-config/acquit/private/scoping/"), `${resolved} must follow XDG_CONFIG_HOME`);
});

test("a default that would land inside a git work tree refuses by name", () => {
	const home = mkdtempSync(join(tmpdir(), "acquit-scoping-repo-"));
	try {
		mkdirSync(join(home, ".git"));
		assert.throws(() => resolveScopingDir({ HOME: home, DATABASE_PATH: join(home, "elsewhere", "acquit.db") }), /git work tree/);
	} finally { cleanUp(home); }
});

test("a relative config root resolves to an absolute directory instead of hanging the guard", () => {
	const dir = mkdtempSync(join(tmpdir(), "acquit-scoping-relcfg-"));
	try {
		// In a child process: before the fix the ancestor walk spins forever on the relative
		// spelling, and the probe is killed rather than wedging the suite. The working directory
		// sits outside every git work tree, so the resolved store is a legal one.
		const resolver = JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "scoping-dir.ts")).href);
		const dbPath = JSON.stringify(join(dir, "acquit.db"));
		const probeScript = [
			`process.chdir(${JSON.stringify(dir)});`,
			`const { resolveScopingDir } = await import(${resolver});`,
			`const xdg = resolveScopingDir({ XDG_CONFIG_HOME: "cfg", DATABASE_PATH: ${dbPath} });`,
			`const fromHome = resolveScopingDir({ HOME: "relhome", DATABASE_PATH: ${dbPath} });`,
			`console.log(xdg);`,
			`console.log(fromHome);`,
		].join("\n");
		const probe = spawnSync(process.execPath, ["--input-type=module", "-e", probeScript], { encoding: "utf8", timeout: 10_000 });
		assert.equal(probe.status, 0, probe.signal
			? `the resolution was killed (${probe.signal}): a relative config root must resolve or refuse, never hang`
			: `the resolution failed: ${probe.stderr}`);
		const [xdg, fromHome] = probe.stdout.trim().split("\n");
		assert.ok(isAbsolute(xdg), `${xdg} must be absolute`);
		assert.ok(xdg.startsWith(`${join(dir, "cfg", "acquit", "private", "scoping")}/`), `${xdg} must resolve the relative XDG root against the working directory`);
		assert.ok(isAbsolute(fromHome) && fromHome.startsWith(`${join(dir, "relhome", ".config", "acquit", "private", "scoping")}/`), `${fromHome} must resolve a relative HOME too`);
	} finally { cleanUp(dir); }
});
