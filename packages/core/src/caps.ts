// Judge mode's caps. One table holds every limit and the reservation kind that spends it, and one
// closed code names each refusal. The counters read cap_reservations, an append-only table written
// inside the same transaction that commits the act it pays for: two workers cannot both pass a check
// that is not yet a row, and a settled job or a shifted job clock cannot change what a visitor spent.

import type { DatabaseSync } from "node:sqlite";
import { instant } from "./ids.ts";
import type { Instant } from "./ids.ts";
import type { UsdCents } from "./ledger.ts";

/** A day, rolling: no timezone decides when a judge's day ends. */
export const CAP_WINDOW_MS = 86_400_000;

/** The start of the window a cap at `now` counts. */
export function capWindowStart(now: Instant): Instant {
	return instant(new Date(Date.parse(now) - CAP_WINDOW_MS).toISOString());
}

/** The three acts a cap pays for. A reservation names one, with the scope it is counted in. */
export type CapKind = "VISITOR" | "JOB" | "RUN";

/**
 * One act's spend, written in the transaction that commits the act. Append-only: nothing releases a
 * reservation, so a settled, refunded, or clock-shifted job can never un-spend what it spent.
 */
export type Reservation = {
	readonly kind: CapKind;
	/** What the cap counts it under: an address for a visitor, the visitor's own id for its jobs and runs. */
	readonly scope: string;
	/** The act's own id (visitor, job, or run), so one act can never reserve twice. */
	readonly ref: string;
	readonly cents: UsdCents;
	/** The deployment's own instant, never a job's shifted one. */
	readonly at: Instant;
};

/**
 * The counters one scope holds inside the window, read from the reservations that committed. The
 * deployment-wide counters (visitorsToday, runsToday) ignore the scope; the rest are the scope's own.
 */
export type CapUsage = {
	readonly visitorsFromIp: number;
	readonly visitorsToday: number;
	readonly jobs: number;
	readonly budget: UsdCents;
	readonly runs: number;
	readonly runsToday: number;
};

/** One row per closed refusal code: the limit, the kind that spends it, the counter it reads, and how. */
export const CAPS = {
	VISITORS_IP_DAY: { limit: 3, kind: "VISITOR", counter: "visitorsFromIp", mode: "count", scope: "visitors from one address in 24 h" },
	VISITORS_DAY: { limit: 50, kind: "VISITOR", counter: "visitorsToday", mode: "count", scope: "visitors in 24 h" },
	VISITOR_JOBS: { limit: 3, kind: "JOB", counter: "jobs", mode: "count", scope: "one visitor's jobs" },
	AMOUNT: { limit: 100_000, kind: "JOB", counter: null, mode: "value", scope: "one job's budget, in cents" },
	SPEND_DAY: { limit: 200_000, kind: "JOB", counter: "budget", mode: "sum", scope: "one visitor's promised budget in 24 h, in cents" },
	MODEL_RUNS: { limit: 10, kind: "RUN", counter: "runs", mode: "count", scope: "one visitor's verifier runs in 24 h" },
	MODEL_RUNS_DAY: { limit: 1_000, kind: "RUN", counter: "runsToday", mode: "count", scope: "verifier runs in 24 h, the free tier's day" },
} as const satisfies Record<string, { readonly limit: number; readonly kind: CapKind;
	readonly counter: keyof CapUsage | null; readonly mode: "count" | "sum" | "value"; readonly scope: string }>;

export type CapName = keyof typeof CAPS;
/** The closed refusal codes. Every cap refusal this deployment answers is one of these. */
export type CapRefusal = `CAP_${CapName}`;

/**
 * The counters one scope holds, read at one instant from the reservations that committed. This is
 * the only counter read: a projection, a job row, and a shifted instant are not a spend.
 */
export function capUsage(db: DatabaseSync, input: { readonly scope: string; readonly since: Instant }): CapUsage {
	const count = (where: string, ...params: readonly string[]): number => {
		const row = db.prepare(`SELECT COUNT(*) AS n FROM cap_reservations WHERE ${where}`).get(...params) as { readonly n?: unknown };
		return Number(row?.n ?? 0);
	};
	const sum = (where: string, ...params: readonly string[]): number => {
		const row = db.prepare(`SELECT COALESCE(SUM(cents), 0) AS n FROM cap_reservations WHERE ${where}`).get(...params) as { readonly n?: unknown };
		return Number(row?.n ?? 0);
	};
	return {
		visitorsFromIp: count("kind = 'VISITOR' AND scope = ? AND at_wall > ?", input.scope, input.since),
		visitorsToday: count("kind = 'VISITOR' AND at_wall > ?", input.since),
		jobs: count("kind = 'JOB' AND scope = ? AND at_wall > ?", input.scope, input.since),
		budget: sum("kind = 'JOB' AND scope = ? AND at_wall > ?", input.scope, input.since) as UsdCents,
		runs: count("kind = 'RUN' AND scope = ? AND at_wall > ?", input.scope, input.since),
		runsToday: count("kind = 'RUN' AND at_wall > ?", input.since),
	};
}

/** The first refusal this reservation must pass, or null. One table row per cap, in table order. */
export function reservationRefusal(reservation: Reservation, usage: CapUsage): CapRefusal | null {
	for (const name of Object.keys(CAPS) as CapName[]) {
		const spec = CAPS[name];
		if (spec.kind !== reservation.kind) continue;
		const used = spec.counter === null ? 0 : usage[spec.counter];
		const spent = spec.mode === "value" ? reservation.cents : spec.mode === "sum" ? used + reservation.cents : used + 1;
		if (spent > spec.limit) return `CAP_${name}`;
	}
	return null;
}
