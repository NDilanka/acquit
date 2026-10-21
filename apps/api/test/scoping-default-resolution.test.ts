// The production-default chain from approval to verifier resolution: with no ACQUIT_SCOPING_DIR
// anywhere, the API's approval parks the private file in the deployment's private store — the
// per-database subdirectory under ~/.config/acquit/private, outside every git work tree, never
// beside the database (which for a lane run is inside the gitignored worktree) — and the
// verifier's own production resolution, on the same environment, is that same directory, so the
// approved set resolves in the book by its digest. ACQUIT_DEV=1 stands in only for the fixture
// registry and the seeded sign-in; the scoping resolution itself runs on defaults alone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { instant } from "../../../packages/core/src/ids.ts";
import type { Digest } from "../../../packages/core/src/ids.ts";
import { hiddenManifest } from "../../../packages/verifier/hidden.ts";
import { loadScopingBook } from "../../../packages/verifier/fixtures.ts";

const root = join(import.meta.dirname, "..");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4";
const now = instant("2026-10-14T12:00:00Z");

function bootServer(port: number, dbPath: string, home: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				// The production default under test: the scoping store is never named for this process,
				// and the profile root is this run's own home, never the operator's.
				ACQUIT_SCOPING_DIR: "", XDG_CONFIG_HOME: "", HOME: home,
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673", FACTORY_API_KEY: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => rejectBoot(new Error(`server did not boot: ${out} ${err}`)), 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			out += String(chunk);
			if (out.includes("Acquit API:")) { clearTimeout(timer); resolveBoot(child); }
		});
		child.stderr.on("data", (chunk: Buffer) => { err += String(chunk); });
		child.on("exit", (code) => { clearTimeout(timer); rejectBoot(new Error(`server exited early (${code}): ${out} ${err}`)); });
	});
}

const post = (port: number, path: string, payload: unknown, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });

const draftedCases = [
	{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "three decimals" },
	{ id: "draft:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500", citation: "minor-unit count" },
	{ id: "draft:3", target: { module: "src/money.ts", export: "formatTotal" }, args: [2500, "KWD"], expected: "2.500", citation: "three decimals" },
];

test("an approval parked under production defaults is the file the verifier's own default resolves, outside every repository", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-defaults-"));
	const home = join(dir, "home");
	await mkdir(home, { recursive: true });
	// The database lives in a git work tree, the way a lane's database lives in the gitignored
	// worktree: the private store must never follow it inside.
	const repoDir = join(dir, "repo");
	await mkdir(repoDir, { recursive: true });
	const init = spawnSync("git", ["init", "--quiet", repoDir], { encoding: "utf8" });
	assert.equal(init.status, 0, init.stderr);
	const dbPath = join(repoDir, "acquit.db");
	const port = 4885;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, dbPath, home);
		const signed = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signed.status, 200);
		const maya = ((await signed.json()) as { token: string }).token;
		const opened = await post(port, "/api/commands", { key: crypto.randomUUID(),
			command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
				budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }, maya);
		assert.equal(opened.status, 200, "the open committed");
		const jobId = ((await opened.json()) as { outcome: { result: { job: { id: string } } } }).outcome.result.job.id;

		// The kick settles before the draft is parked: the pipeline never writes again once its row
		// has left DRAFTING. This boot holds no App and no Factory key, so it settles as FAILED.
		const db = () => new DatabaseSync(dbPath);
		let settled = false;
		for (let i = 0; i < 200 && !settled; i += 1) {
			const row = db().prepare("SELECT status FROM job_scoping WHERE job_id = ?").get(jobId);
			settled = row !== undefined && String((row as { status: string }).status) !== "DRAFTING";
			if (!settled) await new Promise(resolveTick => setTimeout(resolveTick, 25));
		}
		assert.ok(settled, "the scoping kick settled");

		// The park stands in for the pipeline's own write: one row, one private file, at the store
		// the verifier's own production resolution names — the same environment, no override — so
		// the approval committing here is the proof that the API's default is that store too.
		const { scopingDirResolution } = await import("../../../packages/verifier/config.ts");
		const env = { DATABASE_PATH: dbPath, HOME: home, XDG_CONFIG_HOME: "" };
		const storeDir = scopingDirResolution(env);
		await mkdir(storeDir, { recursive: true, mode: 0o700 });
		await writeFile(join(storeDir, `${jobId}.json`), JSON.stringify({
			version: 1, jobId, repository: "maya-client/invoice-app",
			issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" }, frozenAt: frozenCommit,
			contract: "Every total formats to the currency's own minor-unit count.", approved: null, cases: draftedCases,
		}, null, "\t"), { mode: 0o600 });
		db().prepare("INSERT OR REPLACE INTO job_scoping VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(jobId, "AWAITING_APPROVAL",
			"Totals round wrong: BHD and its friends carry three decimals, and JPY keeps none.",
			JSON.stringify(draftedCases.map(test => test.id)), null, null,
			JSON.stringify({ candidates: 3, f1: 3, f2: 3, f3: 3, f4: 3, deduped: 3 }), now);

		const approved = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:3"] }, maya);
		const frozen = (await approved.json()) as { digest: string; approvedIds: string[] };
		assert.equal(approved.status, 200, `the approval committed at the store both processes resolve: ${JSON.stringify(frozen)}`);

		// The file is where the default said it would land, and nowhere in the database's repo.
		const parkedPath = join(storeDir, `${jobId}.json`);
		const parked = JSON.parse(await readFile(parkedPath, "utf8")) as { approved: string | null };
		assert.ok(parked.approved, "the approval parked the file under the default store");
		assert.ok(!resolve(storeDir).startsWith(resolve(repoDir)), "the store never sits inside the database's repository");
		assert.equal(existsSync(join(repoDir, "scoping")), false, "the old beside-the-database location holds nothing");
		for (let at = resolve(storeDir); at !== "/"; at = dirname(at)) {
			assert.ok(!existsSync(join(at, ".git")), `${at} holds a git work tree; the scoping store must not`);
		}

		// Private means private: the store's directory mode 0700, its files 0600.
		assert.equal(statSync(storeDir).mode & 0o777, 0o700, "the store's directory is 0700");
		assert.equal(statSync(parkedPath).mode & 0o777, 0o600, "the scoping file is 0600");

		// The verifier's book resolves the approved set by the digest the freeze recorded.
		const entry = loadScopingBook(storeDir).get(frozen.digest as Digest);
		assert.ok(entry, "the verifier's book resolves the approved set by its digest");
		assert.equal(entry!.jobId, jobId);
		assert.deepEqual(entry!.cases.map(test => test.id), frozen.approvedIds);
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
