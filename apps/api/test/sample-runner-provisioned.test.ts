// The hosted sample runner over the real provisioned flow. The visitor is provisioned through the real
// provisionDemoVisitor, plugged and examined through the same helpers the API routes call, and its standing
// orders are written to the same tables. The runner's bids and submits go through the real command edge, the
// House client accepts, funds and approves through the real core tick, and the verifier's verdicts and run
// failures arrive as real signed callbacks through the real parser and core ingestion, all over a real SQLite
// database. Only the boundaries a deployment injects are controlled: the GitHub App, the scripted git push,
// the PayPal client, and the verifier's run starts. Nothing here calls GitHub, PayPal, Docker or the network.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { closeAcquit, createAcquit, provisionDemoVisitor } from "../../../packages/core/src/acquit.ts";
import type { Acquit } from "../../../packages/core/src/acquit.ts";
import { nextCreditGrant } from "../../../packages/core/src/credits.ts";
import { createFakeGitHubApp } from "../../../packages/core/src/github.ts";
import { instant } from "../../../packages/core/src/ids.ts";
import type { CaptureId, CommitSha, Digest, Instant, JobId, MerchantId, OperatorId, OrderId, PayoutItemId, VisitorId } from "../../../packages/core/src/ids.ts";
import { commercialSplit, usd } from "../../../packages/core/src/ledger.ts";
import type { UsdCents } from "../../../packages/core/src/ledger.ts";
import { parseWebhookEnvelope, quote } from "../../../packages/core/src/paypal.ts";
import type { Bps, CaptureEvidence, FeeQuote, PayPal, PayPalCall, ProcessorFeeModel, ReleaseEvidence, RemoteOutcome, WebhookResource } from "../../../packages/core/src/paypal.ts";
import { openDatabase } from "../../../packages/core/src/store.ts";
import type { VerifierPort, VerifierRunRequest } from "../../../packages/core/src/verifier.ts";
import { lastingAccounts, newVisitorId, visitorRepositoryName } from "../../../packages/core/src/visitors.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import { parseCallbackBody } from "../../../packages/verifier/ci.ts";
import { demoFixture, DEMO_REPOSITORY } from "../../../packages/core/test/hidden-fixture.ts";
import { activityJson } from "../src/sample-activity.ts";
import { createSampleRunner, sampleRunJobs } from "../src/sample-runner.ts";
import { jobRowsOfTenant, listAgentRows, plugSample, standingOrdersOf, startExam, writeStandingOrders } from "../src/specialists.ts";

const CALLBACK_SECRET = "sample-runner-callback-secret";
const MERCHANT = "sandbox-seller" as MerchantId;
/** The fee model in the deployment's shape. AcceptBid quotes every accepted bid with it. */
const FEE_MODEL: ProcessorFeeModel = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
/** The standing-order floor every test bids at, except the low-floor one: 10.00 USD, paying 9.00 after the 10 percent split. */
const FLOOR_CENTS = 1_000;
const START = "2026-11-11T12:00:00.000Z";
const SCENARIO = demoFixture();
const sha = (text: string): CommitSha => createHash("sha1").update(text).digest("hex") as CommitSha;

type StartedRun = { readonly jobId: JobId; readonly ordinal: number; readonly runId: string; readonly sourceCommit: CommitSha };

/** A PayPal fake that answers as the live client does for card funding: a card order is captured when it is created. */
function fakePayPal(now: () => Instant, dispatches: string[]): PayPal {
	const quotes = new Map<string, FeeQuote>();
	const cardOrders = new Set<string>();
	const quoteOf = (key: string): FeeQuote => {
		const found = quotes.get(key);
		if (!found) throw new Error(`no order for ${key}`);
		return found;
	};
	const capture = (orderId: OrderId, payee: MerchantId): CaptureEvidence => {
		const found = quoteOf(orderId);
		return { orderId, captureId: `CAPTURE-${orderId}` as CaptureId, payee, disbursement: "DELAYED", gross: found.split.held,
			processorFee: found.predictedProcessorFee, platformFee: found.platformFeeInstruction, sellerNet: found.split.operatorNet, capturedAt: now() };
	};
	return {
		async dispatch(call: PayPalCall): Promise<RemoteOutcome> {
			// Every call that reaches PayPal's write path is recorded by kind, so a test can name the ones a run never sent.
			dispatches.push(call.kind);
			if (call.kind === "CREATE_ORDER") {
				const orderId = `ORDER-${call.jobId}` as OrderId;
				quotes.set(orderId, call.quote);
				if (call.fundingMode === "card") cardOrders.add(orderId);
				return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER" } };
			}
			if (call.kind === "CAPTURE") return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture: capture(call.orderId, call.payee) } };
			if (call.kind === "RELEASE") {
				const found = quoteOf(call.captureId.replace("CAPTURE-", ""));
				const release: ReleaseEvidence = { payoutItemId: `PAYOUT-${call.captureId}` as PayoutItemId, captureId: call.captureId,
					paid: found.split.operatorNet, at: now() };
				return { kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED", release } };
			}
			throw new Error(`the fake has no ${call.kind}`);
		},
		async reconcile(): Promise<RemoteOutcome> { return { kind: "NOT_FOUND" }; },
		async getOrder(orderId: OrderId, payee: MerchantId): Promise<RemoteOutcome> {
			if (!cardOrders.has(orderId)) return { kind: "PENDING", checkAt: now() };
			return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture: capture(orderId, payee) } };
		},
		parseWebhook: async (raw: string) => parseWebhookEnvelope(raw),
		verifyWebhookDelivery: async () => { throw new Error("not used by the sample runner"); },
		readResource: async (_resource: WebhookResource) => { throw new Error("not used by the sample runner"); },
	} as unknown as PayPal;
}

type World = {
	readonly db: DatabaseSync;
	readonly runner: ReturnType<typeof createSampleRunner>;
	readonly logs: readonly string[];
	readonly pushes: readonly { readonly jobId: JobId; readonly tree: string; readonly commit: CommitSha }[];
	readonly startedRuns: readonly StartedRun[];
	readonly dispatches: readonly string[];
	readonly now: () => Instant;
	readonly advance: (ms: number) => void;
	readonly set: (at: string) => void;
	/** Provisions one visitor the way the demo route does, fork and starter jobs included. */
	readonly provision: (ipKey: string) => Promise<VisitorRow>;
	/** Plugs the code sample, runs its simulated exam, and sets autopilot standing orders at the floor. */
	readonly plugExamOrders: (visitor: VisitorRow, floorCents: number) => void;
	readonly tick: () => Promise<void>;
	readonly jobsOf: (visitor: VisitorRow) => ReturnType<typeof jobRowsOfTenant>;
	readonly statusOf: (visitor: VisitorRow) => ReturnType<ReturnType<typeof createSampleRunner>["statusOf"]>;
	readonly activityFor: (visitor: VisitorRow) => ReturnType<typeof activityJson>;
	/** Delivers a real signed VERDICT callback for a started run: the scripted tree passes. */
	readonly deliverVerdict: (run: StartedRun) => Promise<void>;
	/** Delivers a real signed RUN_FAILED callback for a started run: the run ends with no verdict. */
	readonly deliverRunFailed: (run: StartedRun) => Promise<void>;
	readonly dispose: () => Promise<void>;
};

async function provisionedWorld(start: string): Promise<World> {
	const root = await mkdtemp(join(tmpdir(), "acquit-sample-provisioned-"));
	const path = join(root, "acquit.db");
	let at = Date.parse(start);
	const now = () => instant(new Date(at).toISOString());
	const logs: string[] = [];
	const pushes: { readonly jobId: JobId; readonly tree: string; readonly commit: CommitSha }[] = [];
	const startedRuns: StartedRun[] = [];
	const dispatches: string[] = [];
	let acquit!: Acquit;
	// The deployment's CI adapter: it records each run the core starts. The test answers each one with a real
	// signed callback, so a run with no verdict is a real state the core ingests, not a stubbed decision.
	const verifier: VerifierPort = {
		async start(request: VerifierRunRequest) {
			startedRuns.push({ jobId: request.jobId, ordinal: request.ordinal, runId: request.runId, sourceCommit: request.sourceCommit });
		},
		async parseCallback(request: Request) {
			const raw = await request.text();
			const header = request.headers.get("x-acquit-signature") ?? "";
			const expected = createHmac("sha256", CALLBACK_SECRET).update(raw).digest("hex");
			if (header !== `sha256=${expected}`) return null;
			return parseCallbackBody(JSON.parse(raw) as unknown);
		},
	};
	const fixtures = [SCENARIO];
	acquit = createAcquit({
		databaseUrl: path, fixtures, clientRepository: DEMO_REPOSITORY, demo: { merchant: MERCHANT }, clock: { now },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5273", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: MERCHANT, feeModel: FEE_MODEL, fundingMode: () => "card" },
		verifier: { ciUrl: "", callbackSecret: CALLBACK_SECRET }, verifierPort: verifier,
		github: { appId: "", privateKey: "", organization: "acquit-forks" },
		adapters: { paypal: fakePayPal(now, dispatches), github: createFakeGitHubApp() },
	});
	const db = openDatabase(path);
	const visitorView = (visitor: VisitorRow) => ({ id: visitor.id, operatorHandle: visitor.operatorHandle, repository: visitor.repository });
	// The runner's ports are the production wiring's own helpers over this composition's database and clock.
	const runner = createSampleRunner({
		db, enabled: true, now,
		visitors: () => lastingAccounts(db).map(visitor => ({ id: visitor.id, operatorHandle: visitor.operatorHandle, repository: visitor.repository })),
		jobsOf: visitorId => jobRowsOfTenant(db, visitorId),
		agentsOf: handle => listAgentRows(db, handle).map(agent => ({ id: agent.id, task: agent.task, sample: agent.sample !== null, acquitted: agent.acquittal !== null })),
		ordersOf: agentId => {
			const orders = standingOrdersOf(db, agentId);
			return orders === null ? null : { autopilot: orders.autopilot, runsOn: orders.runsOn, priceFloorCents: orders.priceFloorCents };
		},
		fixtureRule: { fixtures, upstream: DEMO_REPOSITORY, scenario: { repository: SCENARIO.repository, issueNumber: SCENARIO.issue.number } },
		feeModel: FEE_MODEL,
		execute: (actor, key, command) => acquit.execute(actor, key, command),
		workspace: {
			push: async (jobId, tree) => {
				const commit = sha(`${tree}:${jobId}`);
				pushes.push({ jobId, tree: tree as string, commit });
				return commit;
			},
		},
		log: line => logs.push(line),
	});
	const deliver = async (body: string): Promise<void> => {
		const signature = createHmac("sha256", CALLBACK_SECRET).update(body).digest("hex");
		const response = await acquit.handleVerifierCallback(new Request("http://acquit.test/api/verifier/callback",
			{ method: "POST", headers: { "x-acquit-signature": `sha256=${signature}` }, body }));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, applied: true }, "the signed callback applied");
	};
	return {
		db, runner, logs, pushes, startedRuns, dispatches, now,
		advance: ms => { at += ms; },
		set: instant_ => { at = Date.parse(instant_); },
		provision: async ipKey => {
			const id: VisitorId = newVisitorId();
			const result = await provisionDemoVisitor(acquit, { id, ipKey,
				fork: async () => ({ kind: "FORKED", repository: `acquit-forks/${visitorRepositoryName(id)}`, id: 1 }) });
			if (result.kind !== "CREATED") throw new Error(`the visitor was not created: ${result.kind}`);
			return result.visitor;
		},
		plugExamOrders: (visitor, floorCents) => {
			const plugged = plugSample(db, visitor.operatorHandle, "code-fixer");
			assert.ok(plugged.ok, "the code sample plugs in");
			const exam = startExam(db, plugged.agent, `exam-${visitor.id}`, now());
			assert.ok(exam.ok, "the simulated exam starts and settles");
			writeStandingOrders(db, plugged.agent.id, { priceFloorCents: floorCents, maxConcurrent: 1, autopilot: true,
				runsOn: "acquit", preApprove: false, preApproveCap: 3 }, now());
		},
		tick: async () => { await acquit.tick(); },
		jobsOf: visitor => jobRowsOfTenant(db, visitor.id),
		statusOf: visitor => runner.statusOf(visitorView(visitor)),
		activityFor: visitor => activityJson({ operatorId: visitor.operatorHandle as OperatorId, limit: 20,
			rows: jobRowsOfTenant(db, visitor.id), sampleJobs: sampleRunJobs(db, visitor.operatorHandle), enabled: true,
			runner: runner.statusOf(visitorView(visitor)) }),
		deliverVerdict: async run => {
			const verdict = { result: "VERIFIED", runId: run.runId, sourceCommit: run.sourceCommit, at: now(),
				mergeCommit: sha(`merge:${run.sourceCommit}`), pullRequest: 13,
				frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "d".repeat(64) as Digest };
			await deliver(JSON.stringify({ jobId: run.jobId, ordinal: run.ordinal, report: { kind: "VERDICT", verdict } }));
		},
		deliverRunFailed: async run => {
			const failure = { runId: run.runId, sourceCommit: run.sourceCommit, at: now(),
				name: "PUBLISH_FAILED", detail: "the verifier's report could not be published" };
			await deliver(JSON.stringify({ jobId: run.jobId, ordinal: run.ordinal, report: { kind: "RUN_FAILED", failure } }));
		},
		dispose: async () => {
			db.close();
			closeAcquit(acquit);
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("a provisioned visitor's sample run is bid, funded, verified and paid through the real command edge", async () => {
	const world = await provisionedWorld(START);
	try {
		const visitor = await world.provision("ip-happy");
		world.plugExamOrders(visitor, FLOOR_CENTS);
		await world.runner.kick();
		const bidJobId = world.jobsOf(visitor).find(row => row.bids.some(bid => bid.operator === visitor.operatorHandle))?.id;
		assert.ok(bidJobId, "the runner bid on one of the visitor's real starter jobs");
		const jobOf = () => world.jobsOf(visitor).find(row => row.id === bidJobId);

		// The House client accepts about 30 seconds after the bid and funds the starter by card, in the real tick.
		world.advance(31_000);
		await world.tick();
		await world.tick();
		const inProgress = jobOf();
		assert.equal(inProgress?.state.status, "IN_PROGRESS", "the House client accepted the bid and funded the starter");
		if (inProgress?.state.status === "IN_PROGRESS") {
			const quoted = quote(commercialSplit(FLOOR_CENTS as UsdCents), FEE_MODEL);
			const held = inProgress.state.escrow.book.find(line => line.kind === "HELD");
			assert.equal(held?.cents, quoted.split.held, "the escrow holds the gross the quote computes");
			assert.equal(quoted.split.held, 1050, "a 1000-cent bid holds 1050 cents gross under the sandbox fee model");
		}

		await world.runner.kick();
		assert.equal(world.pushes.length, 1, "the scripted tree was pushed once");
		assert.equal(world.pushes[0]?.tree, "honest-reference-table");

		await world.runner.kick();
		await world.tick();
		assert.equal(world.startedRuns.length, 1, "the real verifier port started one run");
		const started = world.startedRuns[0]!;
		assert.equal(started.sourceCommit, world.pushes[0]!.commit, "the submitted commit is the pushed commit");
		await world.deliverVerdict(started);

		await world.runner.kick();
		const record = world.db.prepare("SELECT phase, outcome FROM sample_runner_runs WHERE job_id = ?").get(bidJobId) as { readonly phase: string; readonly outcome: string } | undefined;
		assert.equal(record?.phase, "DONE", "the run finished on the real verdict");
		assert.equal(record?.outcome, "VERIFIED", "the run finished on the real verdict");

		// The House client approves about 60 seconds after the verdict, and the release pays the operator.
		world.advance(61_000);
		await world.tick();
		const paid = jobOf();
		assert.equal(paid?.state.status, "PAID", "the House client approved and the release paid the operator");
		if (paid?.state.status === "PAID") {
			const quoted = quote(commercialSplit(FLOOR_CENTS as UsdCents), FEE_MODEL);
			assert.equal(paid.state.payee.price, FLOOR_CENTS);
			assert.equal(paid.state.release.paid, quoted.split.operatorNet, "the payout is the bid price less the platform fee");
			assert.equal(quoted.split.operatorNet, 900, "a 1000-cent bid pays 900 cents under the 10 percent split");
		}
		// The run's end frees the slot in the same tick, so the runner bids the next starter and the House funds that
		// one too. Only the verified job is ever paid out.
		const second = world.jobsOf(visitor).find(row => row.id !== bidJobId);
		assert.ok(second?.bids.some(bid => bid.operator === visitor.operatorHandle), "the next starter is bid on once the first run is done");
		assert.ok(world.dispatches.filter(kind => kind === "CREATE_ORDER").length <= 2, "only starter fundings reached PayPal");
		assert.equal(world.dispatches.filter(kind => kind === "RELEASE").length, 1, "only the verified job's payout reached PayPal");
		assert.deepEqual(world.dispatches.filter(kind => kind !== "CREATE_ORDER" && kind !== "CAPTURE" && kind !== "RELEASE"), [],
			"no refund or dispute ever reached PayPal");
		const activity = world.activityFor(visitor);
		assert.equal(activity.labels.sample, "Sample agent · Simulated", "the sample's work is labelled as simulated");
		assert.equal(activity.activity.find(item => item.jobId === bidJobId)?.state, "RELEASED");
	} finally {
		await world.dispose();
	}
});

test("a price floor the House cannot fund refuses only that visitor, and the shared tick still funds another visitor's starter", async () => {
	const world = await provisionedWorld(START);
	try {
		const older = await world.provision("ip-older");
		world.plugExamOrders(older, 1);
		const newer = await world.provision("ip-newer");
		world.plugExamOrders(newer, FLOOR_CENTS);
		await world.runner.kick();
		const olderStatus = world.statusOf(older);
		assert.equal(olderStatus.decision.status, "REFUSED");
		assert.equal(olderStatus.decision.reason, "PRICE_CANNOT_CARRY_FEE", "the status says why the low-floor visitor waits");
		assert.ok(world.jobsOf(older).every(row => row.bids.every(bid => bid.operator !== older.operatorHandle)),
			"the low-floor visitor places no bid");
		const bidJob = world.jobsOf(newer).find(row => row.bids.some(bid => bid.operator === newer.operatorHandle));
		assert.ok(bidJob, "the other visitor's bid is placed on the same runner tick");

		world.advance(31_000);
		await world.tick();
		await world.tick();
		assert.equal(world.jobsOf(newer).find(row => row.id === bidJob.id)?.state.status, "IN_PROGRESS",
			"one visitor's unfundable floor does not stall the House's pass for another visitor");
		assert.ok(world.jobsOf(older).every(row => row.state.status === "OPEN" && row.bids.every(bid => bid.operator !== older.operatorHandle)),
			"the low-floor visitor's starters wait, still open, with no bid");
	} finally {
		await world.dispose();
	}
});

test("three verifier runs without a verdict close the run, and the activity says closed with the money still held", async () => {
	const world = await provisionedWorld(START);
	try {
		const visitor = await world.provision("ip-verifier");
		world.plugExamOrders(visitor, FLOOR_CENTS);
		await world.runner.kick();
		world.advance(31_000);
		await world.tick();
		await world.tick();
		await world.runner.kick();
		assert.equal(world.pushes.length, 1, "the run was funded and pushed");
		const jobId = world.pushes[0]!.jobId;

		const runIds = new Set<string>();
		for (let run = 1; run <= 3; run++) {
			await world.runner.kick();
			await world.tick();
			const started = world.startedRuns.at(-1);
			assert.ok(started, `verifier run ${run} started`);
			assert.ok(!runIds.has(started.runId), "each retry is its own verifier run");
			runIds.add(started.runId);
			await world.deliverRunFailed(started);
		}
		await world.runner.kick();
		assert.equal(world.startedRuns.length, 3, "no fourth verifier run is started");

		const job = world.jobsOf(visitor).find(row => row.id === jobId);
		assert.equal(job?.state.status, "IN_PROGRESS", "the House still holds the money");
		const reason = sampleRunJobs(world.db, visitor.operatorHandle).get(jobId);
		assert.equal(reason, "verifier gave no verdict in 3 runs", "the closed reason is stored with the run");
		const status = world.statusOf(visitor);
		assert.equal(status.decision.status, "REFUSED", "the run's end is visible, not idle");
		assert.equal(status.decision.reason, "DELIVERY_STOPPED");
		const entry = world.activityFor(visitor).activity.find(item => item.jobId === jobId);
		assert.equal(entry?.state, "CLOSED", "the activity says closed, not silently held");
		assert.equal(entry?.closedReason, reason);
		assert.ok(entry?.moneyHeld, "the held money is still shown");
	} finally {
		await world.dispose();
	}
});

test("a bid refused for exhausted credits is placed after the weekly grant, with no day-long hold", async () => {
	// Saturday, so the starter's delivery window is still open when Monday's grant arrives.
	const world = await provisionedWorld("2026-11-14T12:00:00.000Z");
	try {
		const visitor = await world.provision("ip-credits");
		world.plugExamOrders(visitor, FLOOR_CENTS);
		// The exhausted-account state, as a week of bids would leave it: no allowance, nothing purchased.
		const row = world.db.prepare("SELECT json FROM credits WHERE id = ?").get(visitor.operatorHandle) as { readonly json: string } | undefined;
		assert.ok(row, "the provisioned operator holds a credit account");
		const account = JSON.parse(row.json) as { readonly balance: { readonly allowance: number; readonly purchased: number } };
		world.db.prepare("UPDATE credits SET json = ? WHERE id = ?")
			.run(JSON.stringify({ ...account, balance: { allowance: 0, purchased: 0 } }), visitor.operatorHandle);

		await world.runner.kick();
		assert.equal(sampleRunJobs(world.db, visitor.operatorHandle).size, 0, "a never-placed bid keeps no run record");
		assert.ok(world.logs.some(line => line.includes("bid not placed: INSUFFICIENT_CREDITS")));
		assert.notEqual(world.statusOf(visitor).decision.reason, "BID_DENIED", "an exhausted account is not a day-long hold");

		// Monday's grant arrives through the real core tick, and the starter is bid on once the retry window has passed.
		world.set(new Date(Date.parse(nextCreditGrant(world.now())) + 1_000).toISOString());
		await world.tick();
		world.advance(2 * 60_000);
		await world.runner.kick();
		const bid = world.jobsOf(visitor).flatMap(job => job.bids).find(entry => entry.operator === visitor.operatorHandle);
		assert.ok(bid, "the never-placed bid is retried after the grant, not permanently excluded");
		assert.equal(bid.price, FLOOR_CENTS);
		assert.equal(bid.status, "PENDING");
	} finally {
		await world.dispose();
	}
});
