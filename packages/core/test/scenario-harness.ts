// The in-process composition the scenario tests share: a scripted verifier port that answers each tree
// with the verdict its score card corpus entry pins, a fake PayPal port with the observations the live
// client returns, the fake GitHub app, and a fresh database per harness. The real judge runs in
// score-card.test.ts on CI. Nothing here calls GitHub or PayPal.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAcquit, createAcquit, provisionDemoVisitor } from "../src/acquit.ts";
import type { Acquit, DemoVisitorResult } from "../src/acquit.ts";
import { createFakeGitHubApp } from "../src/github.ts";
import { instant } from "../src/ids.ts";
import type { CaptureId, CommitSha, Digest, Instant, JobId, MerchantId, OrderId, PayoutBatchId, PayoutItemId, RefundId, TestId } from "../src/ids.ts";
import type { FixtureContract } from "../src/fixtures.ts";
import { usd } from "../src/ledger.ts";
import type { Bps, CaptureEvidence, FeeQuote, PayPal, PayPalCall, RefundEvidence, ReimbursementEvidence, ReleaseEvidence, RemoteOutcome } from "../src/paypal.ts";
import { boundedRuns, startScenario } from "../src/scenarios.ts";
import type { ScenarioDeps, ScenarioName, ScenarioRun, ScenarioRuns, ScriptedTree, StartedScenario } from "../src/scenarios.ts";
import { SqliteStore, openDatabase } from "../src/store.ts";
import { newVisitorId } from "../src/visitors.ts";
import type { VisitorRow } from "../src/visitors.ts";
import type { RejectReason, Verdict, VerifierPort, VerifierRunRequest } from "../src/verifier.ts";
import { parseCallbackBody } from "../../verifier/ci.ts";
import { demoFixture, DEMO_REPOSITORY } from "./hidden-fixture.ts";

const CALLBACK_SECRET = "scenario-callback-secret";
const merchant = "sandbox-seller" as MerchantId;
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const EPOCH = instant("2026-10-06T12:00:00Z");
const PULL_REQUEST = 13;

const sha = (text: string): CommitSha => createHash("sha1").update(text).digest("hex") as CommitSha;

/** The verdict each scripted tree earns, in the words the score card corpus pins for it. */
function verdictFor(tree: ScriptedTree, request: VerifierRunRequest, at: Instant): Verdict {
	const common = { runId: request.runId, sourceCommit: request.sourceCommit, at };
	if (tree === "honest-reference-table") {
		return { result: "VERIFIED", ...common, mergeCommit: sha(`merge:${request.sourceCommit}`), pullRequest: PULL_REQUEST,
			frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, reportDigest: "d".repeat(64) as Digest };
	}
	const reasons: readonly [RejectReason, ...RejectReason[]] = tree === "cheat-hardcode-visible-values"
		? [{ kind: "TESTS_FAILED", suite: "hidden", failed: ["hidden:1" as TestId] }]
		: [{ kind: "PROTECTED_PATH_MODIFIED", path: "tests/totals.test.ts" }];
	return { result: "REJECTED", ...common, reasons, reasonsTruncated: 0 };
}

/**
 * A PayPal fake that answers as the live client does for the two funding sources. A card order is captured
 * when it is created, so its order reads as completed. A checkout order reads PENDING until a buyer approves
 * it, and nothing in these scenarios approves one.
 */
function fakePayPal(now: () => Instant): PayPal {
	const quotes = new Map<string, FeeQuote>();
	const cardOrders = new Set<string>();
	const quoteOf = (key: string): FeeQuote => {
		const quote = quotes.get(key);
		if (!quote) throw new Error(`no order for ${key}`);
		return quote;
	};
	const capture = (orderId: OrderId, payee: MerchantId): CaptureEvidence => {
		const quote = quoteOf(orderId);
		return { orderId, captureId: `CAPTURE-${orderId}` as CaptureId, payee, disbursement: "DELAYED", gross: quote.split.held,
			processorFee: quote.predictedProcessorFee, platformFee: quote.platformFeeInstruction, sellerNet: quote.split.operatorNet, capturedAt: now() };
	};
	const unused = (): never => { throw new Error("not used by the scenarios"); };
	return {
		async dispatch(call: PayPalCall, requestId: string): Promise<RemoteOutcome> {
			if (call.kind === "CREATE_ORDER") {
				const orderId = `ORDER-${call.jobId}` as OrderId;
				quotes.set(orderId, call.quote);
				if (call.fundingMode === "card") cardOrders.add(orderId);
				return { kind: "CONFIRMED", observation: { kind: "ORDER_CREATED", orderId, approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER" } };
			}
			if (call.kind === "CAPTURE") return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture: capture(call.orderId, call.payee) } };
			if (call.kind === "RELEASE") {
				const quote = quoteOf(call.captureId.replace("CAPTURE-", ""));
				const release: ReleaseEvidence = { payoutItemId: `PAYOUT-${call.captureId}` as PayoutItemId, captureId: call.captureId, paid: quote.split.operatorNet, at: now() };
				return { kind: "CONFIRMED", observation: { kind: "RELEASE_COMPLETED", release } };
			}
			if (call.kind === "REFUND") {
				const quote = quoteOf(call.captureId.replace("CAPTURE-", ""));
				const refund: RefundEvidence = { refundId: `REFUND-${call.captureId}` as RefundId, captureId: call.captureId, refunded: call.amount,
					retainedProcessorFee: quote.predictedProcessorFee, at: now() };
				return { kind: "CONFIRMED", observation: { kind: "REFUND_COMPLETED", refund } };
			}
			if (call.kind === "REIMBURSE") {
				const reimbursement: ReimbursementEvidence = { batchId: `BATCH-${requestId}` as PayoutBatchId, itemId: `ITEM-${requestId}` as PayoutItemId,
					merchant: call.merchant, paid: call.amount, fee: usd("0.25"), at: now() };
				return { kind: "CONFIRMED", observation: { kind: "REIMBURSEMENT_COMPLETED", reimbursement } };
			}
			return unused();
		},
		async reconcile(): Promise<RemoteOutcome> { return { kind: "NOT_FOUND" }; },
		async getOrder(orderId: OrderId, payee: MerchantId): Promise<RemoteOutcome> {
			if (!cardOrders.has(orderId)) return { kind: "PENDING", checkAt: now() };
			return { kind: "CONFIRMED", observation: { kind: "CAPTURE_COMPLETED", capture: capture(orderId, payee) } };
		},
		parseWebhook: unused, verifyWebhookDelivery: unused, readResource: unused,
	} as unknown as PayPal;
}

export type HarnessOptions = {
	readonly devEnabled?: boolean;
	/** The registry the core opens jobs against. Defaults to the one demo fixture. */
	readonly fixtures?: readonly FixtureContract[];
	/** Public funding: the deployment's default is checkout, so only a job's own choice can make it a card. */
	readonly publicFunding?: boolean;
	/** Answers a scripted tree with another tree, so a test can make a scenario's verdict differ from its name. */
	readonly treeFor?: (tree: ScriptedTree) => ScriptedTree;
	/** Holds every verifier verdict until this resolves, so runs stay RUNNING. */
	readonly verdictGate?: Promise<void>;
	readonly waitMs?: number;
};

export type Harness = {
	readonly acquit: Acquit;
	readonly store: SqliteStore;
	readonly deps: ScenarioDeps;
	readonly visitor: VisitorRow;
	/** Provisions one run visitor the way the API does, with no fork: the run's job opens on the fixture's repository. */
	readonly provision: (requester: VisitorRow) => Promise<DemoVisitorResult>;
	readonly dispose: () => Promise<void>;
	readonly setClock: (at: Instant) => void;
};

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "acquit-scenarios-"));
	const path = join(root, "acquit.db");
	let now = EPOCH;
	const clock = () => now;
	const treeBySha = new Map<string, ScriptedTree>();
	let acquit!: Acquit;
	const verifier: VerifierPort = {
		async start(request) {
			const tree = treeBySha.get(request.sourceCommit);
			if (!tree) throw new Error(`no scripted tree for ${request.sourceCommit}`);
			const verdict = verdictFor(tree, request, clock());
			const body = JSON.stringify({ jobId: request.jobId, ordinal: request.ordinal, report: { kind: "VERDICT", verdict } });
			const signature = createHmac("sha256", CALLBACK_SECRET).update(body).digest("hex");
			const answer = () => setImmediate(() => {
				void acquit.handleVerifierCallback(new Request("http://acquit.test/api/verifier/callback", { method: "POST",
					headers: { "x-acquit-signature": `sha256=${signature}` }, body }));
			});
			if (options.verdictGate) void options.verdictGate.then(answer);
			else answer();
		},
		async parseCallback(request: Request) {
			const raw = await request.text();
			const header = request.headers.get("x-acquit-signature") ?? "";
			const expected = createHmac("sha256", CALLBACK_SECRET).update(raw).digest("hex");
			if (header !== `sha256=${expected}`) return null;
			return parseCallbackBody(JSON.parse(raw) as unknown);
		},
	};
	acquit = createAcquit({ databaseUrl: path, fixtures: [...(options.fixtures ?? [demoFixture()])], demo: { merchant }, clock: { now: clock },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5273", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: model, fundingMode: () => options.publicFunding ? "checkout" : "card" },
		verifier: { ciUrl: "", callbackSecret: CALLBACK_SECRET }, verifierPort: verifier,
		github: { appId: "", privateKey: "", organization: "" },
		adapters: { paypal: fakePayPal(clock), github: createFakeGitHubApp() } });
	const store = new SqliteStore(path);
	const noFork = async (): Promise<DemoVisitorResult> => provisionDemoVisitor(acquit, { id: newVisitorId(), ipKey: "scenario-test",
		fork: async () => ({ kind: "NO_APP" }) });
	const provisioned = await noFork();
	if (provisioned.kind !== "CREATED") throw new Error(`the visitor was not created: ${provisioned.kind}`);
	const workspace = {
		async push(jobId: JobId, tree: ScriptedTree): Promise<CommitSha> {
			const scripted = options.treeFor?.(tree) ?? tree;
			const commit = sha(`${tree}:${jobId}`);
			treeBySha.set(commit, scripted);
			return commit;
		},
	};
	const runs: ScenarioRuns = boundedRuns();
	const deps: ScenarioDeps = { acquit, store: { readJob: id => store.readJob(id), db: openDatabase(path) }, workspace, runs,
		now: clock, devEnabled: options.devEnabled ?? true, repository: DEMO_REPOSITORY, issueNumber: 12, pollMs: 5, waitMs: options.waitMs ?? 20_000 };
	return { acquit, store, deps, visitor: provisioned.visitor, provision: async () => noFork(), setClock: at => { now = at; },
		dispose: async () => {
			deps.store.db.close();
			store.close();
			closeAcquit(acquit);
			await rm(root, { recursive: true, force: true });
		} };
}

/**
 * Starts one scenario the way the route does: the store admits the requester first, then the run starts
 * on the visitor it names. The job opens on that visitor's repository, or the fixture's own when it has none.
 */
export async function start(h: Harness, name: ScenarioName, visitor: VisitorRow = h.visitor): Promise<StartedScenario> {
	const admitted = h.deps.runs.admit(h.visitor.id);
	if (admitted.kind === "REFUSED") throw new Error(`admission refused: ${admitted.code}`);
	return startScenario({ ...h.deps, repository: visitor.repository ?? DEMO_REPOSITORY }, name, visitor, h.visitor.id, admitted.slot);
}

export async function drive(h: Harness, name: ScenarioName): Promise<ScenarioRun> {
	return (await start(h, name)).finished;
}

export function assertTimings(run: ScenarioRun): void {
	for (const step of run.steps) assert.equal(step.ms, Date.parse(step.endedAt) - Date.parse(step.startedAt), `${step.name} ms`);
}
