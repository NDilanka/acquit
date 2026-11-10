// The deployment's hosted sample runner. A visitor's own built-in sample agent takes one of the visitor's own
// starter jobs on the scripted fixture, the way a scenario run takes its job. The decisions are in
// packages/core/src/sample-runner.ts. This module reads the visitor's state, performs each action as the visitor's
// own operator, and keeps its run records in the database so a restart picks up where it stopped. The House client
// accepts, funds and approves inside the core's own tick. The real verifier decides every submit. The runner is off
// unless the deployment turns it on.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Actor, CommandOutcome, UserCommand } from "../../../packages/core/src/acquit.ts";
import type { AgentId, CommitSha, JobId, OperatorId, RequestKey, VisitorId } from "../../../packages/core/src/ids.ts";
import { hours } from "../../../packages/core/src/ids.ts";
import { isStarterJob } from "../../../packages/core/src/house-client.ts";
import type { UsdCents } from "../../../packages/core/src/ledger.ts";
import type { ProcessorFeeModel } from "../../../packages/core/src/paypal.ts";
import { attemptHistory } from "../../../packages/core/src/exam.ts";
import { matchFixture, type FixtureContract } from "../../../packages/core/src/fixtures.ts";
import { storedDefinitionOfDone, storedVertical, type JobRow } from "../../../packages/core/src/job.ts";
import { stepKey } from "../../../packages/core/src/scenario-binding.ts";
import type { ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import {
	decideSampleTick, isTransientBidRefusal, runsInWindow, sampleConsentStop, type SampleAction, type SampleDecision, type SampleFacts,
	type SampleJob, type SampleOrders, type SampleRun,
} from "../../../packages/core/src/sample-runner.ts";

/** The scripted tree a sample run pushes. It passes the scenario fixture's frozen suite, so the verifier decides on real work. */
const SAMPLE_TREE = "honest-reference-table";
/** Push or submit failures a run may take before it is closed, so a broken fork cannot hold the slot forever. */
const MAX_FAILURES = 5;
const BID_PITCH = "Hosted sample bid at the price floor";
/**
 * How long one tick's lease lasts. A tick takes the lease again, so a tick that stopped without releasing it frees
 * the lease within this time, and a second process on the same database waits.
 */
const LEASE_MS = 2 * 60 * 1000;
/**
 * How long a visitor waits after a transient bid refusal before the runner bids for it again. The refusal clears by
 * itself, so the wait only limits how often the House is asked while it lasts.
 */
const TRANSIENT_RETRY_MS = 2 * 60 * 1000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS sample_runner_runs (
	job_id TEXT PRIMARY KEY,
	operator_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	placed_at TEXT NOT NULL,
	commit_sha TEXT,
	outcome TEXT,
	failures INTEGER NOT NULL DEFAULT 0,
	closed_reason TEXT
)`;

const LEASE_SCHEMA = `CREATE TABLE IF NOT EXISTS sample_runner_lease (
	name TEXT PRIMARY KEY,
	holder TEXT NOT NULL,
	expires_at TEXT NOT NULL
)`;

export type SampleRunnerVisitor = { readonly id: VisitorId; readonly operatorHandle: string; readonly repository: string | null };
export type SampleRunnerAgent = { readonly id: string; readonly task: string; readonly sample: boolean; readonly acquitted: boolean };

export type SampleRunnerPorts = {
	/** Holds the runner's own run records and its tick lease, in the deployment's database. */
	readonly db: DatabaseSync;
	/** The deployment flag. Off means every tick is a no-op and the status reads OFF. */
	readonly enabled: boolean;
	readonly now: () => string;
	/** The visitors whose accounts last, the same ones the House client opens starters for. */
	readonly visitors: () => readonly SampleRunnerVisitor[];
	/** The stored job rows of one visitor's world, read through the store boundary. */
	readonly jobsOf: (visitorId: VisitorId) => readonly JobRow[];
	/** The agents an operator owns. */
	readonly agentsOf: (operatorHandle: string) => readonly SampleRunnerAgent[];
	/** The standing orders of one agent, or null when it has none. */
	readonly ordersOf: (agentId: string) => SampleOrders | null;
	/** The registry, the upstream its forks come from, and the scenario fixture the scripted tree passes. */
	readonly fixtureRule: SampleFixtureRule;
	/** The fee model the House quotes its accepts with. The runner never bids a price this model cannot carry. */
	readonly feeModel: ProcessorFeeModel;
	/** The command edge, as the API's request path runs it. */
	readonly execute: (actor: Actor, key: RequestKey, command: UserCommand) => Promise<CommandOutcome>;
	/** Pushes the scripted tree to the job's own fork and answers with the commit. */
	readonly workspace: ScenarioWorkspace;
	readonly log?: (line: string) => void;
};

/**
 * The fixture rule a starter must pass before the runner bids on it. `fixtures` and `upstream` are the deployment's own
 * registry and client repository, the ones the job view reads, and `scenario` is the one fixture whose scripted tree the
 * runner pushes. A deployment with no scenario fixture runs no sample.
 */
export type SampleFixtureRule = {
	readonly fixtures: readonly FixtureContract[];
	readonly upstream: string | null;
	readonly scenario: { readonly repository: string; readonly issueNumber: number } | null;
};

export type SampleRunnerStatus = { readonly decision: SampleDecision; readonly queuedSince: string | null; readonly runsToday: number };

/**
 * The runner's loop and its status reads. `kick` starts a tick, or returns the tick already running. `drain` waits for
 * the tick in flight, so a shutdown can close the database after it. A tick runs only while it holds the database lease.
 */
export function createSampleRunner(ports: SampleRunnerPorts): {
	readonly kick: () => Promise<void>;
	readonly drain: () => Promise<void>;
	readonly statusOf: (visitor: SampleRunnerVisitor) => SampleRunnerStatus;
} {
	const log = ports.log ?? ((line: string) => console.log(line));
	ports.db.exec(SCHEMA);
	addClosedReason(ports.db);
	ports.db.exec(LEASE_SCHEMA);
	// This process's identity on the lease.
	const holder = randomUUID();
	// The tick in flight, if any.
	let current: Promise<void> | null = null;
	// When each visitor's run first waited for a free runner. Process-local, and it only feeds the status line.
	const queuedSince = new Map<string, string>();
	// The last idle or refused reason logged per visitor, so a quiet visitor logs once rather than every tick.
	const lastNote = new Map<string, string>();
	// When each visitor may be bid for again after a transient refusal. Process-local: a restart bids again at once.
	const retryAt = new Map<string, number>();

	function kick(): Promise<void> {
		if (current === null) {
			current = tick()
				.catch(error => { log(`sample runner: scan failed; the next tick retries (${failureName(error)})`); })
				.finally(() => { current = null; });
		}
		return current;
	}

	async function drain(): Promise<void> {
		await current;
	}

	async function tick(): Promise<void> {
		if (!ports.enabled) return;
		if (!claimLease()) return;
		try {
			for (const visitor of ports.visitors()) {
				try {
					await tickVisitor(visitor);
				} catch (error) {
					log(`sample runner: a visitor's tick failed; the next tick retries (${failureName(error)})`);
				}
			}
		} finally {
			releaseLease();
		}
	}

	/** Takes the lease when it is free, expired, or already this process's. False means another process is ticking. */
	function claimLease(): boolean {
		const now = new Date(ports.now()).toISOString();
		const expires = new Date(Date.parse(now) + LEASE_MS).toISOString();
		const result = ports.db.prepare(`INSERT INTO sample_runner_lease (name, holder, expires_at) VALUES ('tick', ?, ?)
			ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
			WHERE sample_runner_lease.expires_at <= ? OR sample_runner_lease.holder = excluded.holder`).run(holder, expires, now);
		return Number(result.changes) > 0;
	}

	function releaseLease(): void {
		ports.db.prepare("UPDATE sample_runner_lease SET expires_at = ? WHERE name = 'tick' AND holder = ?")
			.run(new Date(ports.now()).toISOString(), holder);
	}

	/** The status a read shows. It reads only: nothing is written and no command is sent. */
	function statusOf(visitor: SampleRunnerVisitor): SampleRunnerStatus {
		const runsToday = runsInWindow(runsOf(visitor.operatorHandle), ports.now());
		if (!ports.enabled) return { decision: { status: "OFF", reason: null, actions: [], note: null }, queuedSince: null, runsToday };
		const agent = sampleAgentOf(visitor);
		if (agent === undefined) return { decision: idle("no sample agent"), queuedSince: null, runsToday };
		const decision = decisionOf(visitor, agent);
		return { decision, queuedSince: decision.status === "QUEUED" ? queuedSince.get(visitor.id) ?? null : null, runsToday };
	}

	async function tickVisitor(visitor: SampleRunnerVisitor): Promise<void> {
		const agent = sampleAgentOf(visitor);
		// A visitor with no sample agent reads no job rows at all.
		if (agent === undefined) return;
		// After a transient refusal the visitor is left alone until its retry window has passed.
		const resumeAt = retryAt.get(visitor.id);
		if (resumeAt !== undefined) {
			if (Date.parse(ports.now()) < resumeAt) return;
			retryAt.delete(visitor.id);
		}
		const decision = decisionOf(visitor, agent);
		if (decision.status === "QUEUED") {
			if (!queuedSince.has(visitor.id)) queuedSince.set(visitor.id, ports.now());
		} else {
			queuedSince.delete(visitor.id);
		}
		if (decision.note !== null && decision.actions.length === 0) {
			const line = `${decision.status} ${decision.reason ?? ""}: ${decision.note}`;
			if (lastNote.get(visitor.id) !== line) {
				lastNote.set(visitor.id, line);
				log(`sample runner: ${visitor.id} ${line}`);
			}
		}
		for (const action of decision.actions) await perform(visitor, agent.id, action);
	}

	/**
	 * The agent the runner acts for. A live run keeps its own agent even if that agent no longer counts as a sample,
	 * so the run still finishes and frees its slot (consent stops its pushes and submits). Otherwise the first acquitted
	 * sample, else the first sample, so an unacquitted sample listed first never shadows an acquitted one.
	 */
	function sampleAgentOf(visitor: SampleRunnerVisitor): SampleRunnerAgent | undefined {
		const agents = ports.agentsOf(visitor.operatorHandle);
		const live = runsOf(visitor.operatorHandle).find(run => run.phase !== "DONE");
		const own = agents.find(entry => entry.id === live?.agentId);
		if (own !== undefined) return own;
		const samples = agents.filter(entry => entry.sample);
		return samples.find(entry => entry.acquitted) ?? samples[0];
	}

	/** One decision for one visitor's sample agent, from the visitor's own stored rows and the run records as they stand. */
	function decisionOf(visitor: SampleRunnerVisitor, agent: SampleRunnerAgent): SampleDecision {
		const jobs = ports.jobsOf(visitor.id)
			.filter(row => row.tenant === visitor.id)
			.map(row => sampleJobOf(row, isScenarioStarter(row, visitor, ports.fixtureRule)));
		const facts: SampleFacts = {
			enabled: ports.enabled,
			now: ports.now(),
			operatorId: visitor.operatorHandle,
			hasFork: visitor.repository !== null,
			agent: { id: agent.id, task: agent.task, sample: agent.sample, acquitted: agent.acquitted },
			orders: ports.ordersOf(agent.id),
			jobs,
			runs: runsOf(visitor.operatorHandle),
			globalActive: globalActive(),
			feeModel: ports.feeModel,
		};
		return decideSampleTick(facts);
	}

	/** The consent that holds now, read again from the standing orders and the agent, not from the tick's snapshot. */
	function consentNow(visitor: SampleRunnerVisitor, agentId: string): { readonly reason: string; readonly note: string } | null {
		const agent = ports.agentsOf(visitor.operatorHandle).find(entry => entry.id === agentId);
		if (agent === undefined) return { reason: "NOT_A_SAMPLE", note: "the agent is no longer the visitor's" };
		return sampleConsentStop({ orders: ports.ordersOf(agentId), agent, hasFork: visitor.repository !== null });
	}

	async function perform(visitor: SampleRunnerVisitor, agentId: string, action: SampleAction): Promise<void> {
		const operator: Actor = { role: "OPERATOR", operatorId: visitor.operatorHandle as OperatorId, tenant: visitor.id };
		const step = (name: string) => stepKey(`sample:${action.jobId}`, name);
		if (action.kind === "finish") {
			ports.db.prepare("UPDATE sample_runner_runs SET phase = 'DONE', outcome = ?, closed_reason = ? WHERE job_id = ?")
				.run(action.outcome, action.outcome === "CLOSED" ? action.reason : null, action.jobId);
			log(`sample runner: ${action.jobId} ${action.outcome}: ${action.reason}`);
			return;
		}
		// Nothing is sent once consent is gone. The run keeps its record and waits, and its status shows the reason.
		const stop = consentNow(visitor, agentId);
		if (stop !== null) {
			log(`sample runner: ${action.jobId} ${action.kind} not sent: ${stop.note}`);
			return;
		}
		if (action.kind === "bid") {
			// The record is written before the bid is sent, so a crash between the two leaves a run that loses its slot
			// (BID_LOST) rather than a bid no run tracks.
			ports.db.prepare("INSERT INTO sample_runner_runs (job_id, operator_id, agent_id, phase, placed_at, commit_sha, outcome, failures) VALUES (?, ?, ?, 'BID', ?, NULL, NULL, 0)")
				.run(action.jobId, visitor.operatorHandle, agentId, ports.now());
			const outcome = await send(operator, step("place-bid"), { type: "PlaceBid", jobId: action.jobId as JobId,
				price: action.priceCents as UsdCents, eta: hours(action.etaHours), agent: agentId as AgentId, pitch: BID_PITCH });
			if (outcome.kind === "DENIED") {
				// The House took no bid. A transient refusal (busy, short of credits, a state or onboarding step still
				// open) clears by itself, so the record goes and the visitor waits out the retry window before the next
				// bid. Any other refusal is the run's outcome: the job is never bid on again, and the status shows the
				// refusal for a day.
				if (isTransientBidRefusal(outcome.reason)) {
					ports.db.prepare("DELETE FROM sample_runner_runs WHERE job_id = ?").run(action.jobId);
					retryAt.set(visitor.id, Date.parse(ports.now()) + TRANSIENT_RETRY_MS);
					log(`sample runner: ${action.jobId} bid not placed: ${outcome.reason}; the bid is retried in 2 minutes`);
				} else {
					ports.db.prepare("UPDATE sample_runner_runs SET phase = 'DONE', outcome = 'BID_DENIED' WHERE job_id = ?").run(action.jobId);
					log(`sample runner: ${action.jobId} BID_DENIED: ${outcome.reason}`);
				}
				return;
			}
			if (outcome.result.kind !== "BID") { log(`sample runner: ${action.jobId} bid returned ${outcome.result.kind}`); return; }
			log(`sample runner: bid on ${action.jobId}`);
			return;
		}
		if (action.kind === "push") {
			try {
				const commit = await ports.workspace.push(action.jobId as JobId, SAMPLE_TREE);
				ports.db.prepare("UPDATE sample_runner_runs SET phase = 'RAN', commit_sha = ? WHERE job_id = ?").run(commit, action.jobId);
				log(`sample runner: pushed ${SAMPLE_TREE} for ${action.jobId}`);
			} catch (error) {
				failed(action.jobId, `push failed (${failureName(error)})`);
			}
			return;
		}
		// One key per verifier run. A run that ends without a verdict leaves the attempt READY, and its retry is a new run
		// with a new key. Reusing the first key would replay the stored answer and never start the retry.
		const outcome = await send(operator, step(`submit:${action.run}`), { type: "Submit", jobId: action.jobId as JobId, sourceCommit: action.sourceCommit as CommitSha });
		if (outcome.kind === "DENIED") {
			if (outcome.reason !== "BUSY") failed(action.jobId, `submit denied: ${outcome.reason}`);
			return;
		}
		ports.db.prepare("UPDATE sample_runner_runs SET phase = 'SUBMITTED' WHERE job_id = ?").run(action.jobId);
		log(`sample runner: submitted ${action.jobId}`);
	}

	/** A command retried at once while the job is busy, as the scenario steps do. Any other refusal is the caller's. */
	async function send(actor: Actor, key: RequestKey, command: UserCommand): Promise<CommandOutcome> {
		let outcome = await ports.execute(actor, key, command);
		for (let attempt = 0; outcome.kind === "DENIED" && outcome.reason === "BUSY" && attempt < 3; attempt++) {
			outcome = await ports.execute(actor, key, command);
		}
		return outcome;
	}

	/** Counts a failure. The run closes once it has failed too many times, so the slot is never held forever. */
	function failed(jobId: string, reason: string): void {
		ports.db.prepare("UPDATE sample_runner_runs SET failures = failures + 1 WHERE job_id = ?").run(jobId);
		const row = ports.db.prepare("SELECT failures FROM sample_runner_runs WHERE job_id = ?").get(jobId) as { readonly failures: number } | undefined;
		if (row !== undefined && Number(row.failures) >= MAX_FAILURES) {
			ports.db.prepare("UPDATE sample_runner_runs SET phase = 'DONE', outcome = 'CLOSED', closed_reason = ? WHERE job_id = ?").run(reason, jobId);
			log(`sample runner: ${jobId} closed after ${MAX_FAILURES} failures: ${reason}`);
			return;
		}
		log(`sample runner: ${jobId} ${reason}; the next tick retries`);
	}

	function runsOf(operatorId: string): SampleRun[] {
		const rows = ports.db.prepare("SELECT job_id, agent_id, phase, placed_at, commit_sha, outcome, closed_reason FROM sample_runner_runs WHERE operator_id = ? ORDER BY placed_at")
			.all(operatorId) as unknown as readonly RunRecord[];
		return rows.map(row => ({ jobId: row.job_id, agentId: row.agent_id, phase: row.phase as SampleRun["phase"], placedAt: row.placed_at,
			commit: row.commit_sha, outcome: row.outcome as SampleRun["outcome"], closedReason: row.closed_reason }));
	}

	function globalActive(): number {
		const row = ports.db.prepare("SELECT COUNT(*) AS count FROM sample_runner_runs WHERE phase <> 'DONE'").get() as { readonly count: number };
		return Number(row.count);
	}

	return { kick, drain, statusOf };
}

type RunRecord = { readonly job_id: string; readonly agent_id: string; readonly phase: string; readonly placed_at: string; readonly commit_sha: string | null; readonly outcome: string | null; readonly closed_reason: string | null };

function idle(note: string): SampleDecision {
	return { status: "IDLE", reason: null, actions: [], note };
}

/**
 * Whether a stored job is a starter on the scenario fixture, on the visitor's own fork. The fixture is matched by the
 * same rule the job view uses (`matchFixture` with the job's own repository as the actor), then pinned to the scenario,
 * so the runner pushes its scripted tree to a job on the fixture that tree was written for, and to no other.
 */
function isScenarioStarter(row: JobRow, visitor: SampleRunnerVisitor, rule: SampleFixtureRule): boolean {
	const definition = storedDefinitionOfDone(row);
	if (definition === null || rule.scenario === null || visitor.repository === null) return false;
	const repository = definition.issue.repository;
	if (repository !== visitor.repository) return false;
	const matched = matchFixture(rule.fixtures, repository, definition.issue.number, repository, rule.upstream);
	return matched !== null && matched.repository === rule.scenario.repository && matched.issue.number === rule.scenario.issueNumber;
}

/** The fields of a stored job the decision reads. */
function sampleJobOf(row: JobRow, fixtureMatched: boolean): SampleJob {
	const state = row.state;
	// A refund in progress carries no run count, and the decision waits on it anyway.
	const attempts = state.status === "IN_PROGRESS" ? state.attempts : null;
	return {
		id: row.id,
		status: state.status,
		vertical: storedVertical(row),
		budgetCents: row.contract.budget,
		starter: isStarterJob(row),
		fixtureMatched,
		attemptsPhase: attempts?.phase ?? null,
		attemptsRunsStarted: attempts !== null && attempts.phase !== "REFUND_PENDING" ? attempts.runsStarted : null,
		bids: row.bids.map(bid => ({ operator: bid.operator, agent: bid.agent, status: bid.status, placedAt: bid.placedAt, respondBy: bid.respondBy })),
		history: attemptHistory(state).map(record => ({ sourceCommit: record.verdict.sourceCommit, result: record.verdict.result })),
	};
}

/**
 * The jobs one operator's runner holds a record for, each with the reason the runner closed its run on it, or null
 * while the run is open. Such a job is the hosted sample agent's work; no other path writes a record.
 */
export function sampleRunJobs(db: DatabaseSync, operatorId: string): ReadonlyMap<string, string | null> {
	const rows = db.prepare("SELECT job_id, closed_reason FROM sample_runner_runs WHERE operator_id = ?")
		.all(operatorId) as unknown as readonly { readonly job_id: string; readonly closed_reason: string | null }[];
	return new Map(rows.map(row => [String(row.job_id), row.closed_reason === null ? null : String(row.closed_reason)] as const));
}

/** A database made before closed_reason existed gets the column once. */
function addClosedReason(db: DatabaseSync): void {
	const columns = db.prepare("PRAGMA table_info(sample_runner_runs)").all() as unknown as readonly { readonly name: string }[];
	if (!columns.some(column => column.name === "closed_reason")) db.exec("ALTER TABLE sample_runner_runs ADD COLUMN closed_reason TEXT");
}

/** A name for a failure, never its message: a git or PayPal message can carry a credential. */
function failureName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}
