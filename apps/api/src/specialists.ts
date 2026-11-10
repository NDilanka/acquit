// The specialist shell: the sample catalog, the agent list and view shapes, the floor, and the
// plugged-sample write. exam.ts holds the pure gate, record, and grade; this module reads and
// writes the rows and decides nothing itself. The raw handle is the same DatabaseSync the routes
// already prepare against, so these reads see what the routes wrote.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CODE_VERTICAL } from "../../../packages/core/src/code-manifest.ts";
import { bidGate, gradeOf, LASER_VERTICAL, recordOf, sampleOf, SAMPLES } from "../../../packages/core/src/exam.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import type { Acquittal, Agent } from "../../../packages/core/src/operator.ts";
import { withAgentDefaults } from "../../../packages/core/src/operator.ts";

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

/** The jobs rows a record derivation scans, cached 30 s per database so a page of agents scans once. */
export function jobRowsOf(db: DatabaseSync, nowMs: number = Date.now()): readonly JobRow[] {
	const hit = rowsCache.get(db);
	if (hit !== undefined && nowMs - hit.at < ROWS_CACHE_MS) return hit.rows;
	const rows = db.prepare("SELECT json FROM jobs").all().map(row => JSON.parse(String(row.json)) as JobRow);
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
				seeded: agent.acquittal?.examId === "seed" };
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
