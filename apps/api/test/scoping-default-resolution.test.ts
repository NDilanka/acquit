// The production-default chain from approval to verifier resolution: with no ACQUIT_SCOPING_DIR
// anywhere, the API's approval parks the private file beside the database, and the verifier's own
// production resolution — the one its service wiring hands the judge — is the same directory, so
// the approved set resolves in the book by its digest. ACQUIT_DEV=1 stands in only for the fixture
// registry and the seeded sign-in; the scoping resolution itself runs on defaults alone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { instant } from "../../../packages/core/src/ids.ts";
import type { Digest } from "../../../packages/core/src/ids.ts";
import { hiddenManifest } from "../../../packages/verifier/hidden.ts";
import { loadScopingBook } from "../../../packages/verifier/fixtures.ts";

const root = join(import.meta.dirname, "..");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4";
const now = instant("2026-10-14T12:00:00Z");

function bootServer(port: number, dbPath: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				// The production default under test: the scoping store is never named for this process.
				ACQUIT_SCOPING_DIR: "",
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673", HOME: dbPath, FACTORY_API_KEY: "",
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

test("an approval parked under production defaults is the file the verifier's own default resolves", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-defaults-"));
	const dbPath = join(dir, "test.db");
	const port = 4885;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, dbPath);
		const signed = await post(port, "/api/session", { handle: "maya-client" });
		assert.equal(signed.status, 200);
		const maya = ((await signed.json()) as { token: string }).token;
		const opened = await post(port, "/api/commands", { key: crypto.randomUUID(),
			command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
				budget: 40000, deliveryEndsAt: "2026-10-21T12:00:00Z" } }, maya);
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

		// The park stands in for the pipeline's own write: one row, one private file, at the
		// directory the API's production default names — beside the database, never in the repo.
		const scopingDir = join(resolve(dbPath, ".."), "scoping");
		await mkdir(scopingDir, { recursive: true, mode: 0o700 });
		await writeFile(join(scopingDir, `${jobId}.json`), JSON.stringify({
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
		assert.equal(approved.status, 200, `the approval committed: ${JSON.stringify(frozen)}`);

		// The API's own file, where its default said it would land.
		const parked = JSON.parse(await readFile(join(scopingDir, `${jobId}.json`), "utf8")) as { approved: string | null };
		assert.ok(parked.approved, "the approval parked the file under the default directory");

		// The verifier's production resolution, the same environment, no override: the same directory,
		// and the approved set resolves in its book by the digest the freeze recorded.
		const verifier = await import("../../../packages/verifier/config.ts");
		const resolved = (verifier as { scopingDirResolution?: (env: { readonly DATABASE_PATH?: string }) => string })
			.scopingDirResolution?.({ DATABASE_PATH: dbPath });
		assert.ok(resolved, "the verifier's production wiring resolves a scoping directory by default");
		assert.equal(resolve(resolved!), resolve(scopingDir), "the verifier's production default is the store the API wrote");
		const entry = loadScopingBook(resolved!).get(frozen.digest as Digest);
		assert.ok(entry, "the verifier's book resolves the approved set by its digest");
		assert.equal(entry!.jobId, jobId);
		assert.deepEqual(entry!.cases.map(test => test.id), frozen.approvedIds);
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
