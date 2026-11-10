// The specialist shell: the sample catalog, the agent list and view shapes, the floor, and the
// plugged-sample write. exam.ts holds the pure gate, record, and grade; this module reads and
// writes the rows and decides nothing itself. The raw handle is the same DatabaseSync the routes
// already prepare against, so these reads see what the routes wrote.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CODE_VERTICAL } from "../../../packages/core/src/code-manifest.ts";
import { attemptHistory, bidGate, captureAt, GRADE_PER_REJECTED, GRADE_PER_VERIFIED, gradeOf, heldPayee, LASER_VERTICAL, recordOf, sampleOf, SAMPLES } from "../../../packages/core/src/exam.ts";
import type { StandingOrders } from "../../../packages/core/src/exam.ts";
import { captureOf, payeeMerchantOf } from "../../../packages/core/src/job.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import type { Acquittal, Agent } from "../../../packages/core/src/operator.ts";
import { withAgentDefaults } from "../../../packages/core/src/operator.ts";
import type { Instant, OperatorId } from "../../../packages/core/src/ids.ts";
import type { ObjectFact } from "../../../packages/core/src/reconcile.ts";
import { storedJob } from "../../../packages/core/src/store.ts";
import { operatorPayouts } from "./payouts.ts";
import type { ObjectRead } from "./reconciliation.ts";

/** The gate result the API reports on every agent object. Computed against the code vertical even while ACQUIT_EXAM_GATE is off. */
export type GateReport = "OPEN" | "NOT_ACQUITTED" | "WRONG_TASK";

export function gateReport(agent: Agent): GateReport {
	return bidGate(agent, CODE_VERTICAL) ?? "OPEN";
}

/** The API's acquittal shape: the stored value plus the seeded flag, true only for the seed write. */
export function acquittalJson(acquittal: Acquittal | null): { readonly examId: string; readonly at: string; readonly seeded: boolean } | null {
	return acquittal === null ? null : { examId: acquittal.examId, at: acquittal.at, seeded: acquittal.examId === "seed" };
}

/** One agent row, with the defaults an old row reads through. Null when the id names no agent. */
export function readAgentRow(db: DatabaseSync, id: string): Agent | null {
	const row = db.prepare("SELECT json FROM agents WHERE id = ?").get(id);
	return row ? withAgentDefaults(JSON.parse(String(row.json))) : null;
}

/** Every agent of one owner, or every agent when the owner is null (the floor reads all). */
export function listAgentRows(db: DatabaseSync, owner: string | null): Agent[] {
	const rows = owner === null
		? db.prepare("SELECT json FROM agents").all()
		: db.prepare("SELECT json FROM agents WHERE owner = ?").all(owner);
	return rows.map(row => withAgentDefaults(JSON.parse(String(row.json))));
}

const ROWS_CACHE_MS = 30_000;
const rowsCache = new WeakMap<DatabaseSync, { readonly at: number; readonly rows: readonly JobRow[] }>();

/** Every jobs row, each read through storedJob so a legacy row reads as the typed shape. Uncached: the morning report reads the book as it stands. */
export function allJobRows(db: DatabaseSync): readonly JobRow[] {
	return db.prepare("SELECT json FROM jobs").all().map(row => storedJob(JSON.parse(String(row.json)) as JobRow));
}

/** The jobs rows a record derivation scans, cached 30 s per database so a page of agents scans once. */
export function jobRowsOf(db: DatabaseSync, nowMs: number = Date.now()): readonly JobRow[] {
	const hit = rowsCache.get(db);
	if (hit !== undefined && nowMs - hit.at < ROWS_CACHE_MS) return hit.rows;
	const rows = allJobRows(db);
	rowsCache.set(db, { at: nowMs, rows });
	return rows;
}

function gradeAndRecord(db: DatabaseSync, agent: Agent) {
	const record = recordOf(agent.id, jobRowsOf(db));
	return { grade: gradeOf(record, agent.acquittal), record };
}

export type StandingOrdersJson = {
	readonly priceFloorCents: number;
	readonly maxConcurrent: number;
	readonly autopilot: boolean;
	readonly runsOn: "owner" | "acquit";
	readonly preApprove: boolean;
	readonly preApproveCap: number;
	readonly updatedAt: string;
};

/** Null when the agent holds no standing orders: no row means none were ever set. */
export function standingOrdersOf(db: DatabaseSync, agentId: string): StandingOrdersJson | null {
	const row = db.prepare("SELECT * FROM standing_orders WHERE agent_id = ?").get(agentId);
	if (row === undefined) return null;
	return { priceFloorCents: Number(row.price_floor_cents), maxConcurrent: Number(row.max_concurrent),
		autopilot: Number(row.autopilot) === 1, runsOn: String(row.runs_on) === "acquit" ? "acquit" : "owner",
		preApprove: Number(row.pre_approve) === 1, preApproveCap: Number(row.pre_approve_cap), updatedAt: String(row.updated_at) };
}

/** Writes one agent's standing orders. The first PUT creates the row; a later PUT replaces it and stamps updated_at. */
export function writeStandingOrders(db: DatabaseSync, agentId: string, orders: StandingOrders, now: Instant): void {
	db.prepare(`INSERT INTO standing_orders (agent_id, price_floor_cents, max_concurrent, autopilot, runs_on, pre_approve, pre_approve_cap, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET price_floor_cents = excluded.price_floor_cents, max_concurrent = excluded.max_concurrent,
			autopilot = excluded.autopilot, runs_on = excluded.runs_on, pre_approve = excluded.pre_approve,
			pre_approve_cap = excluded.pre_approve_cap, updated_at = excluded.updated_at`)
		.run(agentId, orders.priceFloorCents, orders.maxConcurrent, orders.autopilot ? 1 : 0, orders.runsOn,
			orders.preApprove ? 1 : 0, orders.preApproveCap, now);
}

/** Row 2's entry: the owner's own agent list, one object per agent. */
export function agentListJson(db: DatabaseSync, agent: Agent) {
	const { grade } = gradeAndRecord(db, agent);
	return { id: agent.id, name: agent.name, task: agent.task, runner: agent.runner, sample: agent.sample,
		acquittal: acquittalJson(agent.acquittal), gate: gateReport(agent), grade, standingOrders: standingOrdersOf(db, agent.id) };
}

/** Row 7's view: any signed-in principal reads it, so the prompt digest is never selected here. */
export function agentViewJson(db: DatabaseSync, agent: Agent) {
	const { grade, record } = gradeAndRecord(db, agent);
	return { id: agent.id, name: agent.name, task: agent.task, runner: agent.runner,
		owner: { handle: agent.owner }, acquittal: acquittalJson(agent.acquittal), acquittedAt: agent.acquittal?.at ?? null,
		gate: gateReport(agent), grade, record };
}

/** Row 8: the acquitted agents of every owner, best grade first. Seeded acquittals are labelled, not hidden. */
export function floorJson(db: DatabaseSync) {
	const specialists = listAgentRows(db, null)
		.filter(agent => agent.acquittal !== null)
		.map(agent => {
			const { grade, record } = gradeAndRecord(db, agent);
			return { agentId: agent.id, name: agent.name, task: agent.task, grade, record, earnedCents: record.earnedCents,
				seeded: agent.acquittal?.examId === "seed", gate: gateReport(agent) };
		})
		.sort((a, b) => (b.grade ?? 0) - (a.grade ?? 0));
	return { specialists };
}

/** Row 1: the catalog, with the viewer's own plugged agent named on the sample it came from. */
export function sampleCatalog(viewerAgents: readonly Agent[]) {
	return { samples: SAMPLES.map(sample => ({ id: sample.id, name: sample.name, task: sample.task, runner: sample.runner,
		blurb: sample.blurb, runsOn: "acquit" as const,
		plugged: viewerAgents.find(agent => agent.sample === sample.id)?.id ?? null })) };
}

/** The deterministic digest standing in for a prompt digest: a sample's prompt is Acquit's own text, so no owner digest exists. */
function sampleDigest(sampleId: string): Agent["promptDigest"] {
	return createHash("sha256").update(`acquit-sample:${sampleId}`).digest("hex") as Agent["promptDigest"];
}

export type PlugOutcome =
	| { readonly ok: true; readonly agent: Agent }
	| { readonly ok: false; readonly error: "UNKNOWN_SAMPLE" | "TASK_NOT_EXAMINABLE" | "AGENT_EXISTS" };

/** The sample plug: one agent named `<sample>-<owner>`, task and runner from the catalog, no acquittal. */
export function plugSample(db: DatabaseSync, owner: string, sampleId: string): PlugOutcome {
	const sample = sampleOf(sampleId);
	if (sample === null) return { ok: false, error: "UNKNOWN_SAMPLE" };
	if (sample.task === LASER_VERTICAL) return { ok: false, error: "TASK_NOT_EXAMINABLE" };
	const name = `${sample.id}-${owner}`;
	if (db.prepare("SELECT owner FROM agents WHERE id = ?").get(name) !== undefined) return { ok: false, error: "AGENT_EXISTS" };
	const agent: Agent = { id: name as Agent["id"], owner: owner as Agent["owner"], name, runner: sample.runner,
		promptDigest: sampleDigest(sample.id), tools: [], task: sample.task, acquittal: null, sample: sample.id };
	db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
	return { ok: true, agent };
}

/**
 * Row 11: one operator's morning report since a time. Every list is read from the jobs and payout rows as they
 * stand, and an entry counts when its own `at` is at or after `since`. Grade changes follow the verdicts they came from.
 */
export function morningReport(db: DatabaseSync, operatorId: OperatorId, since: Instant, clientRepository: string) {
	const rows = allJobRows(db);
	const sinceMs = Date.parse(since);
	const during = (at: string): boolean => Date.parse(at) >= sinceMs;
	const bids = rows.flatMap(row => row.bids
		.filter(bid => bid.operator === operatorId)
		.map(bid => ({ jobId: row.id, bidId: bid.id, agentId: bid.agent, amountCents: Number(bid.price), at: bid.placedAt })));
	const wins: { jobId: string; agentId: string; amountCents: number; at: string }[] = [];
	const verified: { jobId: string; agentId: string; runId: string; at: string }[] = [];
	const rejected: { jobId: string; agentId: string; runId: string; at: string }[] = [];
	const gradeChanges: { agentId: string; at: string; delta: number }[] = [];
	for (const row of rows) {
		const payee = heldPayee(row.state);
		if (payee === null || payee.operator !== operatorId) continue;
		// The win is the locked bid's price on the escrow the capture opened, stamped when that capture landed.
		const won = captureAt(row.state);
		if (won !== null) wins.push({ jobId: row.id, agentId: payee.agent, amountCents: Number(payee.price), at: won });
		for (const attempt of attemptHistory(row.state)) {
			const { verdict } = attempt;
			const entry = { jobId: row.id, agentId: payee.agent, runId: verdict.runId, at: verdict.at };
			if (verdict.result === "VERIFIED") {
				verified.push(entry);
				gradeChanges.push({ agentId: payee.agent, at: verdict.at, delta: GRADE_PER_VERIFIED });
			} else {
				rejected.push(entry);
				gradeChanges.push({ agentId: payee.agent, at: verdict.at, delta: -GRADE_PER_REJECTED });
			}
		}
	}
	const payouts = operatorPayouts(db, operatorId, clientRepository).flatMap(row =>
		row.paid === null || row.releasedAt === null || !during(row.releasedAt)
			? []
			: [{ reference: row.payoutItemId, amountCents: row.paid, jobId: row.jobId, at: row.releasedAt }]);
	return {
		since,
		sandbox: true as const,
		bids: bids.filter(entry => during(entry.at)),
		wins: wins.filter(entry => during(entry.at)),
		verified: verified.filter(entry => during(entry.at)),
		rejected: rejected.filter(entry => during(entry.at)),
		payouts,
		gradeChanges: gradeChanges.filter(entry => during(entry.at)),
		preApprovals: [],
	};
}

export type MoneyHeld = {
	readonly held: boolean;
	readonly source: "PAYPAL_READ" | "ESCROW_STATE";
	readonly captureId: string | null;
	readonly captureStatus: string | null;
	readonly checkedAt: Instant;
};

type CaptureFact = Extract<ObjectFact, { readonly kind: "CAPTURE" }>;
const CAPTURE_CACHE_MS = 60_000;
/** A capture read is reused for a minute. Only a FOUND reading is kept, so a refusal is asked again. */
const captureCache = new Map<string, { readonly at: number; readonly fact: CaptureFact }>();

async function captureFactOf(captureId: string, merchant: string | null, read: ObjectRead): Promise<CaptureFact | null> {
	const nowMs = Date.now();
	const hit = captureCache.get(captureId);
	if (hit !== undefined && nowMs - hit.at < CAPTURE_CACHE_MS) return hit.fact;
	const reading = await read({ kind: "CAPTURE", id: captureId, merchant });
	if (reading.state !== "FOUND" || reading.fact.kind !== "CAPTURE") return null;
	captureCache.set(captureId, { at: nowMs, fact: reading.fact });
	return reading.fact;
}

/** Row 12's visibility: the operator the job is locked to, or any operator that bid on it. */
export function operatorHasJob(row: JobRow, operatorId: OperatorId): boolean {
	return heldPayee(row.state)?.operator === operatorId || row.bids.some(bid => bid.operator === operatorId);
}

/**
 * Row 12: whether a job's money is held now. Only an IN_PROGRESS or VERIFIED job holds escrow, so only those read
 * PayPal, and held needs the capture COMPLETED there. The escrow state answers when the read is not made or fails.
 */
export async function moneyHeldOf(row: JobRow, read: ObjectRead | null, now: Instant): Promise<MoneyHeld> {
	const captureId = captureOf(row);
	const holding = row.state.status === "IN_PROGRESS" || row.state.status === "VERIFIED";
	const fromState: MoneyHeld = { held: holding, source: "ESCROW_STATE", captureId, captureStatus: null, checkedAt: now };
	if (!holding || captureId === null || read === null) return fromState;
	const fact = await captureFactOf(captureId, payeeMerchantOf(row), read);
	if (fact === null) return fromState;
	return { held: fact.status === "COMPLETED", source: "PAYPAL_READ", captureId, captureStatus: fact.status, checkedAt: now };
}
