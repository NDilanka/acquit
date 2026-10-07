// Perf probe for F2: Approve to PAID, and the webhook route's own work.
//
//   node scripts/perf/release.mjs --jobs 5
//   node scripts/perf/release.mjs --jobs 1 --lane 11
//
// Per job it resets the disposable client repo and the lane's seeded database, funds a job by the dev
// card source, submits fix-honest through the verifier, approves the judged commit, waits for PAID,
// waits for the merge, then delivers one capture envelope and replays the recorded envelope five times.
// The reset is per job because the seed grants one weekly allowance of 30 credits and a bid costs 10: a
// lane that runs more than three jobs would refuse the fourth bid with INSUFFICIENT_CREDITS, and every
// job deserves the same starting state anyway. A reset invalidates sessions, so the probe signs in again
// after it.
//
// Metrics.
//   Approve to PAID: the seconds from the Approve POST to the first job view that reads PAID, polled
//   every 200 ms. The Approve command drains its own RELEASE effect inline, so this is the path the
//   page waits on, not a background one.
//   Webhook route: the envelope the route recorded for the capture is rebuilt and replayed five times.
//   Every delivery re-reads the
//   capture and its order from PayPal, so a route-only number is not observable from outside: each
//   sample is the client-observed POST time minus the probe's own read of the same two resources,
//   minted with the same credentials and the same PayPal-Auth-Assertion the route uses. The difference
//   is the route's own work — parse, record, index lookup, apply, answer. One unrouted body per job is
//   also posted; the route answers it with no PayPal call at all, so its time is the route's floor.
// Rules. Fail if the Approve-to-PAID median exceeds 20 seconds. Fail if the route median excluding
// PayPal calls exceeds 500 ms. A metric that cannot be measured is reported as `blocked` and exits 1.
//
// Baseline. Trunk has no release or webhook route, so it cannot produce either metric. The nearest
// comparable number is the probe's own PayPal read (the capture and its order), reported per job.
//
// Cleanup. The lane is stopped, every work repo the jobs created is deleted with the installation token
// of the owner that holds it, the per-run askpass directories are removed, and the disposable client
// repo is reset to the frozen commit after each merging job and again at the end. Merges target the
// disposable repo only: no job in this probe ever approves or merges against the shared
// NDilanka/invoice-app fixture.
//
// The disposable repo is created and reset by the task's helper, `scratch/client-repo.mjs` in the main
// checkout; pass --helper to name another copy.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGitHubApp, workRepoName } from "../../packages/core/src/github.ts";
import { authAssertion } from "../../packages/core/src/paypal.ts";
import { FROZEN_AT } from "../../packages/core/src/seed-data.ts";
import { captured, portOpen, sleep } from "../../packages/ctl/src/process.ts";
import { laneSlot } from "../../packages/ctl/src/state.ts";
import { githubAppEnv } from "../../packages/verifier/config.ts";
import { dockerReachable } from "../../packages/verifier/subject.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { values } = parseArgs({ options: {
	jobs: { type: "string", default: "5" },
	lane: { type: "string", default: "11" },
	"client-repo": { type: "string", default: "NDilanka/invoice-app-f2-perf" },
	helper: { type: "string", default: "/home/factory-user/repos/acquit/scratch/client-repo.mjs" },
	evidence: { type: "string", default: "data/evidence/f2-r4/perf" },
} });
const jobs = Number(values.jobs);
const lane = Number(values.lane);
assert(Number.isSafeInteger(jobs) && jobs >= 1, "Use at least one job.");
assert(Number.isSafeInteger(lane) && lane >= 1, "Use a lane number of 1 or more: lane 0 is the real database.");
const clientRepo = String(values["client-repo"]);
const [clientOwner, clientName] = clientRepo.split("/");
const tag = /^invoice-app-([a-z0-9-]{1,30})$/.exec(clientName ?? "")?.[1];
assert(clientOwner !== undefined && tag !== undefined,
	"--client-repo must be <owner>/invoice-app-<tag>: that is the shape the disposable-repo helper creates and resets.");
const helper = String(values.helper);
const evidence = resolve(root, values.evidence);
const slot = laneSlot(lane);
const laneDatabase = resolve(root, slot.databasePath);
const apiUrl = `http://127.0.0.1:${slot.apiPort}`;
const fixture = resolve(root, process.env.ACQUIT_VERIFIER_FIXTURE ?? "../../acquit/scratch/verifier/invoice-app");
// The plan's numbers: a 400.00 USD job whose 420.00 USD escrow (price + 5% client fee) funds the
// operator's 360.00 USD share, held by the card source. Devon bids the price, as the plan's ledger does.
const BUDGET = 40_000;
const BID_PRICE = 40_000;
const ISSUE_NUMBER = 12;
const REPLAYS = 5;
const RULES = { approveToPaidMedianSeconds: 20, webhookMedianMs: 500 };
const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";

const report = { jobs, lane, clientRepo, helper, fixture, rules: RULES, baseline:
	"trunk has no release or webhook route; the nearest PayPal round trip is the probe's own capture and order read",
	approveToPaid: null, webhook: null, jobDetail: [], cleanup: null, blocked: null, detail: null, passed: false, node: process.version };
const created = { clientRepo: false, workRepos: [], askpassDirs: [] };

/** One report, one reason, and a nonzero exit. Cleanup below still runs. */
class Blocked extends Error {
	constructor(reason, detail) { super(detail); this.reason = reason; this.detail = detail; }
}

async function main() {
	if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
	try {
		await preflight();
		await ctl("seed-db", "--yes");
		await ctl("start", "--timeout", "180");
		await ctl("fund-mode", "card");
		const approveSeconds = [];
		const webhookSamples = [];
		for (let index = 0; index < jobs; index++) {
			// A lane that runs several jobs resets its fixture first, so each job's bid has the weekly
			// allowance the seed grants. The reset invalidates sessions: mint this job's after it.
			if (index > 0) await ctl("seed-db", "--yes");
			const maya = await signIn("maya-client");
			const devon = await signIn("devon-ops");
			const job = await oneJob(index, maya, devon);
			report.jobDetail.push(job.detail);
			approveSeconds.push(job.approveToPaidSeconds);
			webhookSamples.push(...job.samples);
			console.log(JSON.stringify({ job: job.detail.jobId, approveToPaidSeconds: round(job.approveToPaidSeconds), routeMs: round(job.detail.routeMedianMs) }));
		}
		const routeMedians = webhookSamples.map(sample => sample.excludedMs);
		report.approveToPaid = { samples: approveSeconds.map(round), medianSeconds: round(median(approveSeconds)), worstSeconds: round(Math.max(...approveSeconds)),
			passed: median(approveSeconds) <= RULES.approveToPaidMedianSeconds };
		report.webhook = { method: `the envelope the route recorded for the capture is rebuilt from its fields and replayed ${REPLAYS} times per job; each sample subtracts the probe's own capture+order read from the POST it observed, and one unrouted envelope is posted with no PayPal call at all`,
			samples: webhookSamples.map(sample => ({ ...sample, replayMs: round(sample.replayMs), paypalMs: round(sample.paypalMs), excludedMs: round(sample.excludedMs), unroutedMs: round(sample.unroutedMs) })),
			replayMedianMs: round(median(webhookSamples.map(sample => sample.replayMs))), paypalMedianMs: round(median(webhookSamples.map(sample => sample.paypalMs))),
			medianMs: round(median(routeMedians)), worstMs: round(Math.max(...routeMedians)), unroutedMedianMs: round(median(webhookSamples.map(sample => sample.unroutedMs))),
			passed: median(routeMedians) <= RULES.webhookMedianMs };
		report.passed = report.approveToPaid.passed && report.webhook.passed;
	} catch (error) {
		report.blocked = error instanceof Blocked ? error.reason : "PROBE_FAILED";
		report.detail = error instanceof Error ? error.message : String(error);
	} finally {
		report.cleanup = await cleanup();
	}
	await mkdir(evidence, { recursive: true });
	await writeFile(resolve(evidence, "release.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report));
}

async function preflight() {
	assert(existsSync(helper), `No disposable-repo helper at ${helper}. Pass --helper <path>.`);
	assert(existsSync(resolve(fixture, ".git")), `No invoice-app fixture at ${fixture}. Set ACQUIT_VERIFIER_FIXTURE.`);
	assert.equal(spawnSync("git", ["-C", fixture, "cat-file", "-e", `${FROZEN_AT}^{commit}`]).status, 0,
		`The fixture does not carry the frozen commit ${FROZEN_AT.slice(0, 7)}.`);
	assert(dockerReachable(), "The Docker subject is unreachable: the verifier cannot judge a submission.");
	githubAppEnv();
	for (const [name, port] of [["api", slot.apiPort], ["web", slot.webPort], ["verifier", slot.verifierPort]]) {
		assert(!(await portOpen(port)), `Lane ${lane}'s ${name} port ${port} is already open. Stop that process or pass another --lane.`);
	}
}

/** One job, start to finish. Every step asserts the state the next step depends on. */
async function oneJob(index, maya, devon) {
	const stamp = `f2-perf-${index + 1}`;
	const reset = resetClientRepo();
	assert.equal(reset.main, FROZEN_AT.slice(0, 7), "The disposable repo is not at the frozen commit after its reset.");
	const opened = await command(maya, { type: "OpenJob", repository: clientRepo, issueNumber: ISSUE_NUMBER, budget: BUDGET,
		deliveryEndsAt: new Date(Date.now() + 7 * 86400000).toISOString() });
	const jobId = opened.job.id;
	const bid = await command(devon, { type: "PlaceBid", jobId, price: BID_PRICE, eta: 72, agent: "ts-bugfixer",
		pitch: `Perf probe ${stamp}: the honest fix against the frozen suite.` });
	await command(maya, { type: "AcceptBid", jobId, bidId: bid.bid });
	const funded = await waitFor(`job ${jobId} reaching HELD`, 120_000, async () => {
		const view = (await getJob(maya, jobId)).job;
		return view.status === "IN_PROGRESS" && view.escrow === "HELD" ? view : null;
	});
	assert.equal(funded.lockedTo, "devon-ops", `Job ${jobId} locked to ${funded.lockedTo}, not devon-ops.`);
	const workRepo = `${githubAppEnv().organization}/${workRepoName(clientRepo, jobId)}`;
	created.workRepos.push(workRepo);
	await waitForRepo(workRepo, 120_000);
	const submitted = await submit(jobId, devon, stamp);
	const verified = await waitFor(`job ${jobId} reaching VERIFIED`, 180_000, async () => {
		const view = (await getJob(maya, jobId)).job;
		return view.status === "VERIFIED" ? view : null;
	});
	assert.equal(typeof verified.mergeCommit, "string", "The verified view served no judged commit to approve.");
	const started = performance.now();
	await command(maya, { type: "Approve", jobId, mergeCommit: verified.mergeCommit });
	let last = null;
	const paid = await waitFor(`job ${jobId} reaching PAID`, 120_000, async () => {
		last = (await getJob(maya, jobId)).job;
		return last.status === "PAID" ? last : null;
	}, 200).catch(error => { throw new Blocked("PAID_NOT_REACHED", `Job ${jobId} is ${last?.status ?? "unreadable"} ${last?.phase ?? ""} after 120 seconds: ${error.message}`); });
	const approveToPaidSeconds = (performance.now() - started) / 1000;
	assert.equal(typeof paid.release?.payoutItemId, "string", "The paid view served no referenced payout item id.");
	assert.equal(typeof paid.release?.captureId, "string", "The paid view served no capture id.");
	assert.equal(paid.attempts.used, 1, `The paid view used ${paid.attempts.used} attempts, not 1.`);
	// The merge is a separate outbox effect; whether it already ran is timing, not a rule.
	const mergeAtPaid = paid.merge?.phase ?? null;
	const payout = await readPayoutItem(paid.release.payoutItemId);
	const merged = await waitFor(`job ${jobId}'s merge`, 180_000, async () => {
		const view = (await getJob(maya, jobId)).job;
		if (view.merge?.phase === "NEEDS_HUMAN") throw new Blocked("MERGE_NEEDS_HUMAN", `Job ${jobId}: ${view.merge.reason}`);
		return view.merge?.phase === "MERGED" ? view : null;
	});
	// Reset after each merging job, so the next job's pull request is opened against the frozen main.
	const after = resetClientRepo();
	const webhook = await webhookRoute(jobId, paid.release.captureId, payeeOf(jobId));
	return { approveToPaidSeconds, samples: webhook.samples,
		detail: { jobId, workRepo, pullRequest: paid.pullRequest, mergeCommit: paid.mergeCommit?.slice(0, 7) ?? null,
			captureId: paid.release.captureId, payoutItemId: paid.release.payoutItemId, payoutStatus: payout.status,
			paid: paid.receipt?.paid ?? null, attemptsUsed: paid.attempts.used, merge: merged.merge?.phase ?? null, mergeAtPaid,
			approveToPaidSeconds: round(approveToPaidSeconds), routeMedianMs: round(median(webhook.samples.map(sample => sample.excludedMs))),
			clientRepoOpenPullsAfterReset: after.openPulls } };
}

/** The submit path the operator runs: push the lane's HEAD to the job's work repo, then submit it. */
async function submit(jobId, token, stamp) {
	const laneRepo = resolve(root, `.factory/skills/verify-acquit/scripts/lane-repo.mjs`);
	const prepared = run(process.execPath, [laneRepo, String(lane), "fix-honest", "--jobs", jobId, "--askpass", "--force"], { timeout: 180_000 });
	assert.equal(prepared.code, 0, `lane-repo.mjs failed: ${tail(prepared.stderr)}`);
	const laneRepoDir = JSON.parse(prepared.stdout);
	created.askpassDirs.push(dirname(laneRepoDir.credential.askpass));
	try {
		const cli = run(process.execPath, [resolve(root, "packages/acquit-cli/src/main.ts"), "submit", jobId, "--dir", laneRepoDir.repo,
			"--remote", laneRepoDir.workRemote, "--api", apiUrl, "--token"], { timeout: 300_000, input: `${token}\n`,
			env: { ...laneEnv(), ACQUIT_TOKEN: "", ACQUIT_LANE_ASKPASS_TOKEN_FILE: laneRepoDir.credential.tokenFile,
				GIT_ASKPASS: laneRepoDir.credential.askpass, GIT_CONFIG_GLOBAL: "/dev/null" } });
		const result = String(cli.stdout).match(/^Verifier result: (\w+)$/m)?.[1] ?? null;
		assert.equal(cli.code, 0, `acquit submit exited ${cli.code}: ${tail(cli.stderr)}`);
		assert.equal(result, "VERIFIED", `acquit submit printed ${result ?? "no verdict"} for ${stamp}:\n${tail(cli.stdout, 6)}`);
		return { head: laneRepoDir.head };
	} finally { await rm(dirname(laneRepoDir.credential.askpass), { recursive: true, force: true }).catch(() => {}); }
}

/**
 * One capture envelope, then five replays of the envelope the route recorded for it. Each replay is a
 * whole delivery: the route re-reads the capture and its order from PayPal and finds the job already
 * holds the fact. The probe reads the same two resources itself, so the route's own work is the
 * difference. The route answers only whether it received the delivery, so the outcome phrase is read
 * from the envelope row each delivery wrote.
 */
async function webhookRoute(jobId, captureId, payee) {
	const eventId = `WH-CAPTURE-${createHash("sha256").update(captureId).digest("hex").slice(0, 8).toUpperCase()}`;
	const built = await postWebhook(JSON.stringify({ id: eventId, event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: captureId } }));
	assert.equal(typeof built.body.received, "boolean", "The capture delivery answered no receipt.");
	const recorded = recordedEnvelope(eventId);
	assert(recorded !== null, `The route did not record the capture delivery ${eventId}.`);
	const unroutedId = `WH-PERF-UNROUTED-${jobId}`;
	const unrouted = await postWebhook(JSON.stringify({ id: unroutedId, event_type: "CHECKOUT.ORDER.APPROVED",
		resource_type: "order", resource: { id: `perf-unrouted-${jobId}` } }));
	assert.match(String(recordedEventOutcome(unroutedId)), /not routed/, "The unrouted body was not recorded as unrouted.");
	const samples = [];
	for (let round = 0; round < REPLAYS; round++) {
		const replay = await postWebhook(recorded);
		assert.equal(typeof replay.body.received, "boolean", `Replay ${round + 1} answered no receipt.`);
		const paypal = await paypalRead(captureId, payee);
		samples.push({ jobId, round: round + 1, outcome: recordedEventOutcome(eventId), replayMs: replay.ms, paypalMs: paypal.ms,
			excludedMs: replay.ms - paypal.ms, unroutedMs: unrouted.ms });
	}
	return { samples };
}

/** The same read the route makes: the capture, then the order that carries its completed capture. */
async function paypalRead(captureId, payee) {
	const token = await paypalToken();
	const started = performance.now();
	const capture = await paypalGet(`/v2/payments/captures/${encodeURIComponent(captureId)}`, token, payee);
	const orderId = capture?.supplementary_data?.related_ids?.order_id ?? null;
	assert(typeof orderId === "string", "The capture read named no order, so the route's own read could not be mirrored.");
	await paypalGet(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, token, payee);
	return { ms: performance.now() - started };
}

/** The referenced payout item the release recorded, read back from PayPal: a per-transaction value. */
async function readPayoutItem(itemId) {
	const token = await paypalToken();
	const response = await fetch(`${PAYPAL_BASE}/v1/payments/referenced-payouts-items/${encodeURIComponent(itemId)}`,
		{ headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
	const body = await response.json().catch(() => null);
	assert(response.ok, `The referenced payout item read answered ${response.status}: ${body?.name ?? "no name"}.`);
	const status = body?.processing_state?.status ?? null;
	assert.equal(status, "SUCCESS", `The referenced payout item is ${status}, not SUCCESS.`);
	const amount = body?.payout_amount ?? {};
	return { status, paid: amount.value ?? null, currency: amount.currency_code ?? amount.currency ?? null };
}

let paypalCache = null;
async function paypalToken() {
	if (paypalCache !== null && Date.parse(paypalCache.expiresAt) > Date.now()) return paypalCache.token;
	const id = process.env.PAYPAL_CLIENT_ID?.trim();
	const secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
	assert(id && secret, "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env.");
	const response = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, { method: "POST", redirect: "error",
		headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
		body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000) });
	assert(response.ok, `The sandbox token route answered ${response.status}.`);
	const body = await response.json();
	assert(typeof body.access_token === "string", "The sandbox token route answered no token.");
	paypalCache = { token: body.access_token, expiresAt: new Date(Date.now() + Math.max(0, Number(body.expires_in ?? 300) - 60) * 1000).toISOString() };
	return paypalCache.token;
}

async function paypalGet(path, token, payee) {
	const response = await fetch(`${PAYPAL_BASE}${path}`, { headers: { authorization: `Bearer ${token}`,
		...(payee === null ? {} : { "PayPal-Auth-Assertion": authAssertion(process.env.PAYPAL_CLIENT_ID?.trim() ?? "", payee) }) },
		signal: AbortSignal.timeout(15_000) });
	assert(response.ok, `GET ${path} answered ${response.status}.`);
	return response.json();
}

async function postWebhook(raw) {
	const started = performance.now();
	const response = await fetch(`${apiUrl}/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw, signal: AbortSignal.timeout(120_000) });
	const ms = performance.now() - started;
	const body = await response.json().catch(() => null);
	assert(response.ok, `The webhook route answered ${response.status}: ${body?.error ?? "no error body"}.`);
	return { ms, body };
}

/** The envelope row the route recorded for one event, rebuilt into the delivery a replay posts. */
function recordedEnvelope(eventId) {
	const db = new DatabaseSync(laneDatabase, { readOnly: true });
	try {
		const row = db.prepare("SELECT id, event_type, resource_type, resource_id FROM webhook_events WHERE id = ?").get(eventId);
		return row === undefined ? null : JSON.stringify({ id: String(row.id), event_type: String(row.event_type),
			resource_type: String(row.resource_type), resource: { id: String(row.resource_id) } });
	} finally { db.close(); }
}

/** The outcome phrase this delivery's own envelope row holds. */
function recordedEventOutcome(eventId) {
	const db = new DatabaseSync(laneDatabase, { readOnly: true });
	try { const row = db.prepare("SELECT outcome FROM webhook_events WHERE id = ?").get(eventId); return row === undefined ? null : String(row.outcome); }
	finally { db.close(); }
}

function payeeOf(jobId) {
	const db = new DatabaseSync(laneDatabase, { readOnly: true });
	try {
		const row = db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId);
		assert(row !== undefined, `No stored row for ${jobId}.`);
		return JSON.parse(String(row.json)).state?.payee?.payee ?? null;
	} finally { db.close(); }
}

async function signIn(handle) {
	const response = await fetch(`${apiUrl}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ handle }), signal: AbortSignal.timeout(15_000) });
	assert(response.ok, `POST /api/session for ${handle} answered ${response.status}.`);
	const body = await response.json();
	assert(typeof body.token === "string" && body.token.length > 0, "The session answer carried no token.");
	return body.token;
}

async function command(token, command) {
	const response = await fetch(`${apiUrl}/api/commands`, { method: "POST", signal: AbortSignal.timeout(180_000),
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ key: randomUUID(), command }) });
	const body = await response.json().catch(() => null);
	if (!response.ok || body?.outcome?.kind === "DENIED") throw new Blocked("COMMAND_DENIED",
		`${command.type} answered ${response.status}: ${body?.outcome?.reason ?? body?.error ?? "no reason"}`);
	assert.equal(body?.outcome?.kind, "COMMITTED", `${command.type} did not commit.`);
	return body.outcome.result;
}

async function getJob(token, jobId) {
	const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
	assert(response.ok, `GET /api/jobs/${jobId} answered ${response.status}.`);
	const body = await response.json();
	assert(body?.job, `GET /api/jobs/${jobId} served no job.`);
	return body;
}

async function waitFor(description, timeoutMs, probe, intervalMs = 400) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (performance.now() >= deadline) throw new Blocked("TIMEOUT", `${description} within ${Math.round(timeoutMs / 1000)} seconds.`);
		await sleep(intervalMs);
	}
}

async function waitForRepo(fullName, timeoutMs) {
	const token = await appToken(fullName.split("/")[0]);
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const response = await fetch(`https://api.github.com/repos/${fullName}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "acquit-release-perf" } });
		await response.body?.cancel();
		if (response.status === 200) return;
		assert.equal(response.status, 404, `GET ${fullName} answered ${response.status}.`);
		if (performance.now() >= deadline) throw new Blocked("WORK_REPO_MISSING", `${fullName} did not appear within ${Math.round(timeoutMs / 1000)} seconds.`);
		await sleep(1000);
	}
}

/** One token per owner. A token minted for one owner's installation never reaches another's repositories. */
async function appToken(owner = githubAppEnv().organization) {
	return await createGitHubApp(githubAppEnv()).installationToken(owner);
}

/** Resets the disposable repo to the frozen commit, and reports the state it left behind. */
function resetClientRepo() {
	const result = run(process.execPath, [`--env-file=${resolve(root, ".env")}`, helper, tag], { timeout: 180_000 });
	assert.equal(result.code, 0, `The disposable-repo helper failed: ${tail(result.stderr)}`);
	const answer = JSON.parse(result.stdout);
	assert.equal(answer.repository, clientRepo, `The helper reset ${answer.repository}, not ${clientRepo}.`);
	assert.equal(answer.installed, true, `The App installation cannot see ${clientRepo}.`);
	created.clientRepo = true;
	return answer;
}

async function cleanup() {
	const result = { laneStopped: false, workReposDeleted: [], askpassDirsRemoved: true, clientRepo: null, errors: [] };
	try { await ctl("stop"); result.laneStopped = true; } catch (error) { result.errors.push(`stop: ${message(error)}`); }
	for (const dir of created.askpassDirs) await rm(dir, { recursive: true, force: true }).catch(error => result.errors.push(`askpass: ${message(error)}`));
	for (const fullName of created.workRepos) {
		try {
			await deleteRepo(fullName);
			result.workReposDeleted.push(fullName);
		} catch (error) { result.errors.push(`${fullName}: ${message(error)}`); }
	}
	if (created.clientRepo) {
		try {
			const answer = resetClientRepo();
			result.clientRepo = `reset to ${answer.main}, installed ${answer.installed}, open pull requests ${answer.openPulls}`;
		} catch (error) { result.errors.push(`client repo: ${message(error)}`); }
	}
	return result;
}

/**
 * Deletes one repository with the installation token of the owner that holds it. The disposable-repo
 * helper's own --delete needs a token scope the operator's PAT does not carry, so the App deletes the
 * per-job work repos here; the client repo is reset rather than deleted, so a lane can reuse it.
 */
async function deleteRepo(fullName) {
	const token = await appToken(fullName.split("/")[0]);
	const response = await fetch(`https://api.github.com/repos/${fullName}`, { method: "DELETE", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "acquit-release-perf" } });
	await response.body?.cancel();
	assert([204, 404].includes(response.status), `DELETE ${fullName} answered ${response.status}.`);
}

async function ctl(...args) {
	const result = await captured(process.execPath, ["packages/ctl/src/main.ts", ...args], root, laneEnv(), 300_000);
	const reply = JSON.parse(result.stdout);
	assert(result.code === 0 && reply.ok, reply.error?.message ?? `ctl ${args[0]} failed.`);
	return reply.data;
}

function laneEnv() {
	return { ...process.env, ACQUIT_LANE: String(lane), ACQUIT_DEV: "1", ACQUIT_CLIENT_REPOSITORY: clientRepo };
}

function run(executable, args, options = {}) {
	const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", timeout: options.timeout ?? 180_000,
		env: options.env ?? laneEnv(), input: options.input, maxBuffer: 32 * 1024 * 1024 });
	return { code: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const round = value => Math.round(value * 10) / 10;
const message = error => error instanceof Error ? error.message : String(error);
const tail = (text, lines = 3) => String(text ?? "").trim().split("\n").slice(-lines).join(" ").slice(0, 400);

// The entrypoint runs last: every helper above it is initialized by the time main does any work.
await main();
process.exitCode = report.passed ? 0 : 1;
