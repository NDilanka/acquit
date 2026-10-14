// The scoping review and approval routes over real HTTP: a client reviews its own job's parked
// draft, another role is refused by name, an approval that leaves a coverage family thin refuses
// by naming the family, and the one approval freezes exactly the cases it kept — once.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { instant } from "../../../packages/core/src/ids.ts";
import type { CommitSha, TestId } from "../../../packages/core/src/ids.ts";
import { hiddenManifest } from "../../../packages/verifier/hidden.ts";

const root = join(import.meta.dirname, "..");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
const now = instant("2026-10-14T12:00:00Z");

function bootServer(port: number, dbPath: string, scopingDir: string): Promise<ReturnType<typeof spawn>> {
	return new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: root,
			env: {
				...process.env, PORT: String(port), DATABASE_PATH: dbPath, ACQUIT_DEV: "1",
				ACQUIT_SCOPING_DIR: scopingDir,
				ACQUIT_PLATFORM_KEY: "test-platform-key-0123456789abcdef",
				PAYPAL_CLIENT_ID: "test-client-id", PAYPAL_CLIENT_SECRET: "test-client-secret",
				WEB_ORIGIN: "http://localhost:5673", HOME: scopingDir, FACTORY_API_KEY: "",
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
const get = (port: number, path: string, token?: string) =>
	fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const session = async (port: number, handle: string): Promise<string> => {
	const signed = await post(port, "/api/session", { handle });
	assert.equal(signed.status, 200);
	return (await signed.json() as { token: string }).token;
};

const openJob = async (port: number, token: string): Promise<string> => {
	const opened = await post(port, "/api/commands", { key: crypto.randomUUID(),
		command: { type: "OpenJob", repository: "maya-client/invoice-app", issueNumber: 12,
			budget: 40000, deliveryEndsAt: "2026-10-21T12:00:00Z" } }, token);
	const answer = await opened.json() as { outcome?: { result?: { kind: string; job?: { id: string } } } };
	assert.equal(opened.status, 200, `the open committed: ${JSON.stringify(answer)}`);
	return answer.outcome!.result!.job!.id;
};

const draftedCases = [
	{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235", citation: "three decimals" },
	{ id: "draft:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500", citation: "minor-unit count" },
	{ id: "draft:3", target: { module: "src/money.ts", export: "formatTotal" }, args: [2500, "KWD"], expected: "2.500", citation: "three decimals" },
];

/** Parks a draft for the job the way the pipeline would have: one row, one private file. */
const parkDraft = async (dbPath: string, scopingDir: string, jobId: string) => {
	const db = new DatabaseSync(dbPath);
	db.prepare("INSERT OR REPLACE INTO job_scoping VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(jobId, "AWAITING_APPROVAL",
		"Totals round wrong: BHD and its friends carry three decimals, and JPY keeps none.", JSON.stringify(draftedCases.map(test => test.id)),
		null, null, JSON.stringify({ candidates: 3, f1: 3, f2: 3, f3: 3, f4: 3, deduped: 3 }), now);
	db.close();
	await mkdir(scopingDir, { recursive: true, mode: 0o700 });
	return writeFile(join(scopingDir, `${jobId}.json`), JSON.stringify({
		version: 1, jobId, repository: "maya-client/invoice-app",
		issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" }, frozenAt: frozenCommit,
		contract: "Every total formats to the currency's own minor-unit count.", approved: null, cases: draftedCases,
	}, null, "\t"), { mode: 0o600 });
};

const readManifest = (dbPath: string, jobId: string): { hiddenTests: string[]; hiddenManifest: string } | null => {
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT json FROM job_manifests WHERE job_id = ?").get(jobId);
	db.close();
	return row ? JSON.parse(String(row.json)) : null;
};

const readRow = (dbPath: string, jobId: string): { status: string; digest: string | null; ids: string[] } | null => {
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT status, digest, ids FROM job_scoping WHERE job_id = ?").get(jobId);
	db.close();
	return row ? { status: String(row.status), digest: row.digest === null ? null : String(row.digest), ids: JSON.parse(String(row.ids)) } : null;
};

test("a client reviews its own parked draft, another role is refused, and the approval freezes exactly the kept cases", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-route-"));
	const scopingDir = join(dir, "scoping");
	const port = 4881;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), scopingDir);
		const maya = await session(port, "maya-client");
		const devon = await session(port, "devon-ops");
		const jobId = await openJob(port, maya);

		// The kick ran at open: the job carries a scoping row even when nothing could be drafted here
		// (this boot holds no App and no Factory key, so the honest answer is a FAILED row).
		const kicked = readRow(join(dir, "test.db"), jobId);
		assert.ok(kicked, "OpenJob kicked the scoping pipeline");
		assert.ok(["DRAFTING", "FAILED"].includes(kicked.status), `the kick's row says so, not silent: ${kicked.status}`);

		await parkDraft(join(dir, "test.db"), scopingDir, jobId);

		const anonymous = await get(port, `/api/jobs/${jobId}/scoping`);
		assert.equal(anonymous.status, 401);
		const other = await get(port, `/api/jobs/${jobId}/scoping`, devon);
		assert.equal(other.status, 403, "an operator is not the job's client");
		assert.deepEqual((await other.json()) as unknown, { error: "NOT_OWNER" });

		const review = await get(port, `/api/jobs/${jobId}/scoping`, maya);
		assert.equal(review.status, 200);
		const view = await review.json() as { status: string; issueBody: string; counts: { f4: number };
			contract: string; cases: readonly { id: string; expected: string; citation: string }[] };
		assert.equal(view.status, "AWAITING_APPROVAL");
		assert.match(view.issueBody, /three decimals/);
		assert.equal(view.counts.f4, 3);
		assert.match(view.contract, /minor-unit count/);
		assert.deepEqual(view.cases.map(test => test.id), ["draft:1", "draft:2", "draft:3"]);
		assert.equal(view.cases[0]!.expected, "1.235", "the review shows the case values to the client who approves them");

		const refusedApprove = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:3"] }, devon);
		assert.equal(refusedApprove.status, 403);

		// Leaving out every zero-decimal case leaves the gate's family uncovered, by name.
		await parkDraft(join(dir, "test.db"), scopingDir, jobId);
		const thin = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:2"] }, maya);
		assert.equal(thin.status, 422);
		assert.deepEqual(await thin.json() as unknown, { error: "COVERAGE_GATE", missing: ["zero-decimal"] });
		assert.equal(readRow(join(dir, "test.db"), jobId)!.status, "AWAITING_APPROVAL", "a refused approval freezes nothing");

		const approved = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:3"] }, maya);
		assert.equal(approved.status, 200);
		const frozen = await approved.json() as { digest: string; approvedIds: string[] };
		assert.deepEqual(frozen.approvedIds, ["draft:1", "draft:2"]);
		const kept = draftedCases.filter(test => test.id !== "draft:3").map(test => ({ ...test, id: test.id as TestId }));
		assert.equal(frozen.digest, hiddenManifest(kept).digest, "the digest is the approved set's own");
		const manifest = readManifest(join(dir, "test.db"), jobId);
		assert.ok(manifest);
		assert.deepEqual(manifest!.hiddenTests, ["draft:1", "draft:2"], "the frozen manifest names exactly the approved ids");
		assert.equal(manifest!.hiddenManifest, frozen.digest);
		const row = readRow(join(dir, "test.db"), jobId);
		assert.equal(row!.status, "APPROVED");
		assert.equal(row!.digest, frozen.digest);
		const file = JSON.parse(await readFile(join(scopingDir, `${jobId}.json`), "utf8")) as { approved: string | null; cases: readonly { id: string }[] };
		assert.ok(file.approved, "the private file records the approval");
		assert.deepEqual(file.cases.map(test => test.id), ["draft:1", "draft:2"], "the private file keeps only the approved cases");

		const second = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: [] }, maya);
		assert.equal(second.status, 409, "a frozen draft is immutable");
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("approving every case the draft parked works, and a job with no parked draft refuses by name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-a1-route-"));
	const scopingDir = join(dir, "scoping");
	const port = 4882;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, join(dir, "test.db"), scopingDir);
		const maya = await session(port, "maya-client");
		const jobId = await openJob(port, maya);

		const none = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: [] }, maya);
		assert.equal(none.status, 404, "no parked draft, nothing to approve");
		assert.deepEqual(await none.json() as unknown, { error: "NO_DRAFT" });

		await parkDraft(join(dir, "test.db"), scopingDir, jobId);
		const everything = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: [] }, maya);
		assert.equal(everything.status, 200);
		const kept = draftedCases.map(test => ({ ...test, id: test.id as TestId }));
		const frozen = await everything.json() as { digest: string };
		assert.equal(frozen.digest, hiddenManifest(kept).digest);

		const leaveEverything = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:1", "draft:2", "draft:3"] }, maya);
		assert.equal(leaveEverything.status, 409, "the frozen draft cannot be reopened by leaving everything out");
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
