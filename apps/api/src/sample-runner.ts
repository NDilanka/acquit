// The deployment's hosted sample runner. A visitor's own built-in sample agent takes one of the visitor's own
// starter jobs on the scripted fixture, the way a scenario run takes its job. The decisions are in
// packages/core/src/sample-runner.ts. This module reads the visitor's state, performs each action as the visitor's
// own operator, and keeps its run records in the database so a restart picks up where it stopped. The House client
// accepts, funds and approves inside the core's own tick. The real verifier decides every submit. The runner is off
// unless the deployment turns it on.

import type { DatabaseSync } from "node:sqlite";
import type { Actor, CommandOutcome, UserCommand } from "../../../packages/core/src/acquit.ts";
import type { AgentId, CommitSha, JobId, OperatorId, RequestKey, VisitorId } from "../../../packages/core/src/ids.ts";
import { hours } from "../../../packages/core/src/ids.ts";
import { isStarterJob } from "../../../packages/core/src/house-client.ts";
import type { UsdCents } from "../../../packages/core/src/ledger.ts";
import { attemptHistory } from "../../../packages/core/src/exam.ts";
import { matchFixture, type FixtureContract } from "../../../packages/core/src/fixtures.ts";
import { storedDefinitionOfDone, storedVertical, type JobRow } from "../../../packages/core/src/job.ts";
import { stepKey } from "../../../packages/core/src/scenario-binding.ts";
import type { ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import {
	decideSampleTick, runsInWindow, type SampleAction, type SampleDecision, type SampleFacts, type SampleJob,
	type SampleOrders, type SampleRun,
} from "../../../packages/core/src/sample-runner.ts";

/** The scripted tree a sample run pushes. It passes the scenario fixture's frozen suite, so the verifier decides on real work. */
const SAMPLE_TREE = "honest-reference-table";
/** Push or submit failures a run may take before it is closed, so a broken fork cannot hold the slot forever. */
const MAX_FAILURES = 5;
const BID_PITCH = "Hosted sample bid at the price floor";

const SCHEMA = `CREATE TABLE IF NOT EXISTS sample_runner_runs (
	job_id TEXT PRIMARY KEY,
	operator_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	placed_at TEXT NOT NULL,
	commit_sha TEXT,
	outcome TEXT,
	failures INTEGER NOT NULL DEFAULT 0
)`;

export type SampleRunnerVisitor = { readonly id: VisitorId; readonly operatorHandle: string; readonly repository: string | null };
export type SampleRunnerAgent = { readonly id: string; readonly task: string; readonly sample: boolean; readonly acquitted: boolean };

export type SampleRunnerPorts = {
	/** Holds the runner's own run records, in the deployment's database. */
	readonly db: DatabaseSync;
	/** The deployment flag. Off means every tick is a no-op and the status reads OFF. */
	readonly enabled: boolean;
	readonly now: () => string;
	/** The visitors whose accounts last, the same ones the House client opens starters for. */
	readonly visitors: () => readonly SampleRunnerVisitor[];
	/** Every stored job row, read through the store boundary. The runner picks each visitor's own by tenant. */
	readonly jobs: () => readonly JobRow[];
	/** The agents an operator owns. */
	readonly agentsOf: (operatorHandle: string) => readonly SampleRunnerAgent[];
	/** The standing orders of one agent, or null when it has none. */
	readonly ordersOf: (agentId: string) => SampleOrders | null;
	/** The registry, the upstream its forks come from, and the scenario fixture the scripted tree passes. */
	readonly fixtureRule: SampleFixtureRule;
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

/** The runner's loop and its status reads. Kick it from a timer; it returns at once when a tick is already running. */
export function createSampleRunner(ports: SampleRunnerPorts): {
	readonly kick: () => Promise<void>;
	readonly statusOf: (visitor: SampleRunnerVisitor, rows: readonly JobRow[]) => SampleRunnerStatus;
} {
	const log = ports.log ?? ((line: string) => console.log(line));
	ports.db.exec(SCHEMA);
	let running = false;
	// When each visitor's run first waited for a free runner. Process-local, and it only feeds the status line.
	const queuedSince = new Map<string, string>();
	// The last idle or refused reason logged per visitor, so a quiet visitor logs once rather than every tick.
	const lastNote = new Map<string, string>();

	async function kick(): Promise<void> {
		if (running) return;
		running = true;
		try {
			if (!ports.enabled) return;
			const rows = ports.jobs();
			for (const visitor of ports.visitors()) {
				try {
					await tickVisitor(visitor, rows);
				} catch (error) {
					log(`sample runner: a visitor's tick failed; the next tick retries (${failureName(error)})`);
				}
			}
		} catch (error) {
			log(`sample runner: scan failed; the next tick retries (${failureName(error)})`);
		} finally {
			running = false;
		}
	}

	/** The status a read shows, from the job rows the caller already read. It reads only: nothing is written and no command is sent. */
	function statusOf(visitor: SampleRunnerVisitor, rows: readonly JobRow[]): SampleRunnerStatus {
		const runsToday = runsInWindow(runsOf(visitor.operatorHandle), ports.now());
		if (!ports.enabled) return { decision: { status: "OFF", reason: null, actions: [], note: null }, queuedSince: null, runsToday };
		const agent = sampleAgentOf(visitor);
		if (agent === undefined) return { decision: idle("no sample agent"), queuedSince: null, runsToday };
		const decision = decisionOf(visitor, agent, rows);
		return { decision, queuedSince: decision.status === "QUEUED" ? queuedSince.get(visitor.id) ?? null : null, runsToday };
	}

	async function tickVisitor(visitor: SampleRunnerVisitor, rows: readonly JobRow[]): Promise<void> {
		const agent = sampleAgentOf(visitor);
		if (agent === undefined) return;
		const decision = decisionOf(visitor, agent, rows);
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

	function sampleAgentOf(visitor: SampleRunnerVisitor): SampleRunnerAgent | undefined {
		return ports.agentsOf(visitor.operatorHandle).find(entry => entry.sample);
	}

	/** One decision for one visitor's sample agent, from the stored rows and the run records as they stand. */
	function decisionOf(visitor: SampleRunnerVisitor, agent: SampleRunnerAgent, rows: readonly JobRow[]): SampleDecision {
		const jobs = rows.filter(row => row.tenant === visitor.id).map(row => sampleJobOf(row, isScenarioStarter(row, visitor, ports.fixtureRule)));
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
		};
		return decideSampleTick(facts);
	}

	async function perform(visitor: SampleRunnerVisitor, agentId: string, action: SampleAction): Promise<void> {
		const operator: Actor = { role: "OPERATOR", operatorId: visitor.operatorHandle as OperatorId, tenant: visitor.id };
		const step = (name: string) => stepKey(`sample:${action.jobId}`, name);
		if (action.kind === "finish") {
			ports.db.prepare("UPDATE sample_runner_runs SET phase = 'DONE', outcome = ? WHERE job_id = ?").run(action.outcome, action.jobId);
			log(`sample runner: ${action.jobId} ${action.outcome}: ${action.reason}`);
			return;
		}
		if (action.kind === "bid") {
			// The record is written before the bid is sent, so a crash between the two leaves a run that loses its slot
			// (BID_LOST) rather than a bid no run tracks. A bid the House refuses removes its record again.
			ports.db.prepare("INSERT INTO sample_runner_runs (job_id, operator_id, agent_id, phase, placed_at, commit_sha, outcome, failures) VALUES (?, ?, ?, 'BID', ?, NULL, NULL, 0)")
				.run(action.jobId, visitor.operatorHandle, agentId, ports.now());
			const outcome = await send(operator, step("place-bid"), { type: "PlaceBid", jobId: action.jobId as JobId,
				price: action.priceCents as UsdCents, eta: hours(action.etaHours), agent: agentId as AgentId, pitch: BID_PITCH });
			if (outcome.kind === "DENIED") {
				ports.db.prepare("DELETE FROM sample_runner_runs WHERE job_id = ?").run(action.jobId);
				log(`sample runner: ${action.jobId} bid denied: ${outcome.reason}`);
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
		const outcome = await send(operator, step("submit"), { type: "Submit", jobId: action.jobId as JobId, sourceCommit: action.sourceCommit as CommitSha });
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
			ports.db.prepare("UPDATE sample_runner_runs SET phase = 'DONE', outcome = 'CLOSED' WHERE job_id = ?").run(jobId);
			log(`sample runner: ${jobId} closed after ${MAX_FAILURES} failures: ${reason}`);
			return;
		}
		log(`sample runner: ${jobId} ${reason}; the next tick retries`);
	}

	function runsOf(operatorId: string): SampleRun[] {
		const rows = ports.db.prepare("SELECT job_id, agent_id, phase, placed_at, commit_sha, outcome FROM sample_runner_runs WHERE operator_id = ? ORDER BY placed_at")
			.all(operatorId) as unknown as readonly RunRecord[];
		return rows.map(row => ({ jobId: row.job_id, agentId: row.agent_id, phase: row.phase as SampleRun["phase"], placedAt: row.placed_at,
			commit: row.commit_sha, outcome: row.outcome as SampleRun["outcome"] }));
	}

	function globalActive(): number {
		const row = ports.db.prepare("SELECT COUNT(*) AS count FROM sample_runner_runs WHERE phase <> 'DONE'").get() as { readonly count: number };
		return Number(row.count);
	}

	return { kick, statusOf };
}

type RunRecord = { readonly job_id: string; readonly agent_id: string; readonly phase: string; readonly placed_at: string; readonly commit_sha: string | null; readonly outcome: string | null };

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
	return {
		id: row.id,
		status: state.status,
		vertical: storedVertical(row),
		budgetCents: row.contract.budget,
		starter: isStarterJob(row),
		fixtureMatched,
		attemptsPhase: state.status === "IN_PROGRESS" ? state.attempts.phase : null,
		bids: row.bids.map(bid => ({ operator: bid.operator, agent: bid.agent, status: bid.status, placedAt: bid.placedAt })),
		history: attemptHistory(state).map(record => ({ sourceCommit: record.verdict.sourceCommit, result: record.verdict.result })),
	};
}

/** The job ids the runner holds a record for. Such a job is the hosted sample agent's work; no other path writes a record. */
export function sampleRunJobIds(db: DatabaseSync): ReadonlySet<string> {
	const rows = db.prepare("SELECT job_id FROM sample_runner_runs").all() as unknown as readonly { readonly job_id: string }[];
	return new Set(rows.map(row => String(row.job_id)));
}

/** A name for a failure, never its message: a git or PayPal message can carry a credential. */
function failureName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}
