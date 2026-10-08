// Judge mode's caps. One table holds every limit and the counter it reads, and one closed code names
// each refusal, so a refused caller is told exactly which allowance ran out. The counters are read from
// committed rows: a cap check never writes, so it can refuse a command but never change what one does.

import { instant } from "./ids.ts";
import type { Instant } from "./ids.ts";
import type { UsdCents } from "./ledger.ts";

/** A day, rolling: no timezone decides when a judge's day ends. */
export const CAP_WINDOW_MS = 86_400_000;

/** The start of the window a cap at `now` counts. */
export function capWindowStart(now: Instant): Instant {
	return instant(new Date(Date.parse(now) - CAP_WINDOW_MS).toISOString());
}

/**
 * The counters every cap reads, gathered from committed rows at one instant. `visitor` is true exactly
 * when the counted client is a visitor's own principal: the visitor caps bind it, and nobody else.
 */
export type CapCounts = {
	readonly visitor: boolean;
	/** Visitors created from one address inside the window, and then by anyone at all. */
	readonly visitorsFromIp: number;
	readonly visitorsToday: number;
	/** The counted client's own use: its jobs, what they promise, and every run they have started. */
	readonly jobs: number;
	readonly budget: UsdCents;
	readonly runs: number;
	/** Every run the deployment can date inside the window, which is the free tier's day. */
	readonly runsToday: number;
};

/** One row per closed refusal code: the limit, the counter it reads, and what it protects. */
export const CAPS = {
	VISITORS_IP_DAY: { limit: 3, count: "visitorsFromIp", scope: "visitors from one address in 24 h" },
	VISITORS_DAY: { limit: 50, count: "visitorsToday", scope: "visitors in 24 h" },
	VISITOR_JOBS: { limit: 3, count: "jobs", scope: "one visitor's jobs" },
	AMOUNT: { limit: 100_000, count: null, scope: "one job's budget, in cents" },
	SPEND_DAY: { limit: 200_000, count: "budget", scope: "one visitor's promised budget in 24 h, in cents" },
	MODEL_RUNS: { limit: 10, count: "runs", scope: "one visitor's verifier runs in 24 h" },
	MODEL_RUNS_DAY: { limit: 1_000, count: "runsToday", scope: "verifier runs in 24 h, the free tier's day" },
} as const satisfies Record<string, { readonly limit: number; readonly count: keyof CapCounts | null; readonly scope: string }>;

export type CapName = keyof typeof CAPS;
/** The closed refusal codes. Every cap refusal this deployment answers is one of these. */
export type CapRefusal = `CAP_${CapName}`;

/** The first refusal a table row raises, or null when the act is inside every limit. */
const refused = (codes: readonly (CapRefusal | null)[]): CapRefusal | null => codes.find(code => code !== null) ?? null;
const over = (name: CapName, counts: CapCounts): CapRefusal | null => {
	const spec = CAPS[name];
	const used = spec.count === null ? 0 : counts[spec.count];
	return used >= spec.limit ? `CAP_${name}` : null;
};

/** The caps a new visitor must pass: its address's window, then the deployment's own day. */
export function visitorCap(counts: CapCounts): CapRefusal | null {
	return refused([over("VISITORS_IP_DAY", counts), over("VISITORS_DAY", counts)]);
}

/**
 * The caps one more job of `budget` must pass for the counted client. A client that is not a visitor's
 * is not capped: dev mode's seeded client is the operator's own, and the deployment's day still guards
 * the model spend underneath it.
 */
export function jobCap(counts: CapCounts, budget: UsdCents): CapRefusal | null {
	if (!counts.visitor) return null;
	return refused([over("VISITOR_JOBS", counts),
		budget > CAPS.AMOUNT.limit ? "CAP_AMOUNT" : null,
		counts.budget + budget > CAPS.SPEND_DAY.limit ? "CAP_SPEND_DAY" : null]);
}

/** The caps the run a Submit would start must pass: the owning visitor's, then the deployment's day. */
export function modelRunCap(counts: CapCounts): CapRefusal | null {
	return refused([counts.visitor ? over("MODEL_RUNS", counts) : null, over("MODEL_RUNS_DAY", counts)]);
}
