// The commit-then-reveal over real HTTP: an open or verified job serves the sealed digest and nothing
// that opens it, and a closed job serves the approved cases, the salt, and a digest that recomputes.
// A job that never approved a draft reveals nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestOfHiddenCases } from "../../../packages/core/src/hidden-seal.ts";
import { hiddenManifest } from "../../../packages/verifier/hidden.ts";
import type { TestId } from "../../../packages/core/src/ids.ts";

const root = join(import.meta.dirname, "..");
const frozenCommit = "a3b6ead29f4e367d1871e753b516cc9e832871e4";
const now = "2026-10-14T12:00:00.000Z";
const later = "2026-10-14T13:00:00.000Z";

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

const readManifest = (dbPath: string, jobId: string): { hiddenManifest: string; sealedHiddenCases?: { digest: string } } => {
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT json FROM job_manifests WHERE job_id = ?").get(jobId);
	db.close();
	return JSON.parse(String(row!.json));
};

/** Stands in for work that moved on while the job was open: only the state is replaced, the way the domain stores it. */
const forceState = (dbPath: string, jobId: string, state: unknown) => {
	const db = new DatabaseSync(dbPath);
	const job = JSON.parse(String(db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId)!.json));
	db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run(JSON.stringify({ ...job, state }), jobId);
	db.close();
};

const closedState = { status: "CLOSED", reason: "CLIENT_CANCEL", closedAt: later, book: [] };

/** A VERIFIED job awaiting the client's review: the state the verifier's pass leaves, with the book empty. */
const verifiedState = {
	status: "VERIFIED",
	escrow: { payee: { bidId: "bid_seal-1", operator: "devon-ops", payee: "MERCHANT", agent: "ts-bugfixer", price: 40000, eta: 48 },
		quote: { split: { held: 42000, fee: 6000, operatorNet: 36000, predictedProcessorFee: 1515 }, platformFeeInstruction: 4485, version: "test" },
		capture: { orderId: "ORDER", captureId: "CAPTURE", payee: "MERCHANT", disbursement: "DELAYED", gross: 42000, processorFee: 1515,
			platformFee: 4485, sellerNet: 36000, capturedAt: now },
		book: [], cutoffAt: "2026-10-27T12:00:00.000Z" },
	history: [],
	passed: { ordinal: 1, verdict: { result: "VERIFIED", runId: "run_seal-1", sourceCommit: "b".repeat(40), mergeCommit: "c".repeat(40),
		pullRequest: 13, frozen: { expected: 1, passed: 1 }, hidden: { expected: 2, passed: 2 }, reportDigest: "d".repeat(64), at: now } },
	review: { phase: "AWAITING_CLIENT", endsAt: later },
	runsStarted: 1,
};

const approvedIds = ["draft:1", "draft:2"];
/** The approved set as the verifier runs it: the citation left out, the id, target, args, and expected kept. */
const keptCases = draftedCases.filter(test => approvedIds.includes(test.id))
	.map(({ id, target, args, expected }) => ({ id: id as TestId, target, args, expected }));

test("an open job serves the sealed digest and no case, salt, or reveal; the approval seals under the private salt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-commit-reveal-"));
	const scopingDir = join(dir, "scoping");
	const dbPath = join(dir, "test.db");
	const port = 4891;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, dbPath, scopingDir);
		const maya = await session(port, "maya-client");
		const devon = await session(port, "devon-ops");
		const jobId = await openJob(port, maya);
		await parkDraft(dbPath, scopingDir, jobId);

		const approved = await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:3"] }, maya);
		assert.equal(approved.status, 200);
		const frozen = await approved.json() as { digest: string; approvedIds: string[] };
		assert.deepEqual(frozen.approvedIds, approvedIds);

		const manifest = readManifest(dbPath, jobId);
		assert.equal(manifest.hiddenManifest, frozen.digest, "the existing manifest digest is unchanged");
		assert.equal(manifest.hiddenManifest, hiddenManifest(keptCases).digest);
		assert.match(manifest.sealedHiddenCases!.digest, /^[0-9a-f]{64}$/);

		const scopingFile = JSON.parse(await readFile(join(scopingDir, `${jobId}.json`), "utf8")) as { salt: string };
		assert.match(scopingFile.salt, /^[0-9a-f]{64}$/, "the private file holds the salt");
		assert.equal(digestOfHiddenCases(keptCases, scopingFile.salt), manifest.sealedHiddenCases!.digest,
			"the sealed digest opens under the private salt once the cases are known");

		const asClient = await get(port, `/api/jobs/${jobId}`, maya);
		assert.equal(asClient.status, 200);
		const clientBody = await asClient.text();
		const clientJob = JSON.parse(clientBody) as { job: { status: string; contract: { sealedHiddenCases: { digest: string } | null }; hiddenReveal: unknown } };
		assert.equal(clientJob.job.status, "OPEN");
		assert.deepEqual(clientJob.job.contract.sealedHiddenCases, { digest: manifest.sealedHiddenCases!.digest });
		assert.equal(clientJob.job.hiddenReveal, null, "an open job reveals nothing");
		assert.equal(clientBody.includes(scopingFile.salt), false, "the salt is not served on the job route");

		const asOperator = await get(port, `/api/jobs/${jobId}`, devon);
		assert.equal(asOperator.status, 200);
		const operatorBody = await asOperator.text();
		assert.equal(operatorBody.includes(scopingFile.salt), false, "no operator reads the salt before close");
		assert.equal((JSON.parse(operatorBody) as { job: { hiddenReveal: unknown } }).job.hiddenReveal, null);

		const review = await get(port, `/api/jobs/${jobId}/scoping`, maya);
		assert.equal(review.status, 200);
		assert.equal((await review.text()).includes(scopingFile.salt), false, "the review route does not serve the salt");
		const otherReview = await get(port, `/api/jobs/${jobId}/scoping`, devon);
		assert.equal(otherReview.status, 403, "an operator reads no draft, so no case value either");
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a verified job serves the seal and no reveal until it closes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-commit-reveal-"));
	const scopingDir = join(dir, "scoping");
	const dbPath = join(dir, "test.db");
	const port = 4892;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, dbPath, scopingDir);
		const maya = await session(port, "maya-client");
		const jobId = await openJob(port, maya);
		await parkDraft(dbPath, scopingDir, jobId);
		assert.equal((await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:3"] }, maya)).status, 200);
		const sealed = readManifest(dbPath, jobId).sealedHiddenCases!.digest;
		const scopingFile = JSON.parse(await readFile(join(scopingDir, `${jobId}.json`), "utf8")) as { salt: string };

		forceState(dbPath, jobId, verifiedState);
		const body = await (await get(port, `/api/jobs/${jobId}`, maya)).text();
		const job = JSON.parse(body) as { job: { status: string; phase: string; contract: { sealedHiddenCases: { digest: string } }; hiddenReveal: unknown } };
		assert.equal(job.job.status, "VERIFIED");
		assert.equal(job.job.phase, "AWAITING_CLIENT");
		assert.deepEqual(job.job.contract.sealedHiddenCases, { digest: sealed });
		assert.equal(job.job.hiddenReveal, null, "a verified job is not closed, so nothing is revealed");
		assert.equal(body.includes(scopingFile.salt), false);
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a closed job serves the approved cases, the salt, and a digest that recomputes to the sealed one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-commit-reveal-"));
	const scopingDir = join(dir, "scoping");
	const dbPath = join(dir, "test.db");
	const port = 4893;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, dbPath, scopingDir);
		const maya = await session(port, "maya-client");
		const jobId = await openJob(port, maya);
		await parkDraft(dbPath, scopingDir, jobId);
		assert.equal((await post(port, `/api/jobs/${jobId}/scoping/approve`, { leaveOut: ["draft:3"] }, maya)).status, 200);
		const sealed = readManifest(dbPath, jobId).sealedHiddenCases!.digest;

		forceState(dbPath, jobId, closedState);
		const detail = await get(port, `/api/jobs/${jobId}`, maya);
		assert.equal(detail.status, 200);
		const job = await detail.json() as { job: { status: string; contract: { sealedHiddenCases: { digest: string } }; hiddenReveal: {
			cases: unknown; salt: string; digest: string } | null } };
		assert.equal(job.job.status, "CLOSED");
		assert.deepEqual(job.job.contract.sealedHiddenCases, { digest: sealed });
		const reveal = job.job.hiddenReveal;
		assert.ok(reveal, "a closed job with a per-job seal reveals");
		assert.deepEqual(reveal.cases, [
			{ id: "draft:1", target: { module: "src/money.ts", export: "formatTotal" }, args: [1235, "BHD"], expected: "1.235" },
			{ id: "draft:2", target: { module: "src/money.ts", export: "formatTotal" }, args: [123500, "JPY"], expected: "123500" },
		], "the approved cases only, with the citation left out");
		const scopingFile = JSON.parse(await readFile(join(scopingDir, `${jobId}.json`), "utf8")) as { salt: string };
		assert.equal(reveal.salt, scopingFile.salt);
		assert.equal(reveal.digest, sealed);
		assert.equal(digestOfHiddenCases(keptCases, reveal.salt), sealed, "the published set recomputes to the frozen digest");
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a closed job that never approved a draft reveals nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-commit-reveal-"));
	const scopingDir = join(dir, "scoping");
	const dbPath = join(dir, "test.db");
	const port = 4894;
	let child: ReturnType<typeof spawn> | null = null;
	try {
		child = await bootServer(port, dbPath, scopingDir);
		const maya = await session(port, "maya-client");
		const jobId = await openJob(port, maya);

		forceState(dbPath, jobId, closedState);
		const job = await (await get(port, `/api/jobs/${jobId}`, maya)).json() as { job: { status: string; contract: { sealedHiddenCases: unknown } | null; hiddenReveal: unknown } };
		assert.equal(job.job.status, "CLOSED");
		assert.equal(job.job.contract !== null && "sealedHiddenCases" in job.job.contract, false, "the fixture's curated set carries no seal");
		assert.equal(job.job.hiddenReveal, null, "the curated set never reveals");
	} finally {
		child?.kill("SIGKILL");
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
