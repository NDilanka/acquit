// The print demo's server side. A signed-in visitor starts one simulated farm's run and reads it back. A run
// qualifies the farm and, when it qualifies, prints one job that the real print judge verifies. The run's work
// executes in its own worker thread, so its CPU time never holds the API's event loop, and the API stops that
// thread at the run's deadline. It never opens a job in the core, never reads or writes the job store, and never
// calls PayPal or GitHub. The run lives on the server, so a closed tab does not stop it. Its bounds are a running
// run per visitor, a starts-per-hour cap per visitor, two runs in flight at once, a deadline per run, and a store
// that keeps the newest runs and drops the oldest finished one. A restart forgets the runs; nothing else is kept.

import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { instantAt } from "../../../packages/verifier-print/src/open.ts";
import type { PrintDemoRun, RunInput } from "../../../packages/verifier-print/src/run.ts";
import { parseFarmMode } from "../../../packages/verifier-print/src/sim/farm.ts";
import type { FarmMode } from "../../../packages/verifier-print/src/sim/farm.ts";
import type { PrintWorkerReply } from "./print-worker.ts";

export const PRINT_RUNNING_PER_REQUESTER = 1;
export const PRINT_RUNNING_TOTAL = 2;
export const PRINT_STARTS_PER_HOUR = 12;
export const PRINT_RUNS_KEPT = 200;
export const PRINT_RUN_DEADLINE_MS = 120_000;
/** The most heap one run's worker may use, in MB. A run that outgrows it fails and does not take the API down. */
export const PRINT_WORKER_HEAP_MB = 512;
const HOUR_MS = 3_600_000;

export type PrintRunState = "RUNNING" | "DONE" | "FAILED";

/** A run as the store keeps it. The result is the run's own record, and it is set once the run stops. */
export type PrintRunRecord = {
	readonly id: string;
	readonly requesterId: string;
	readonly farm: FarmMode;
	readonly state: PrintRunState;
	readonly startedAt: string;
	readonly endedAt: string | null;
	readonly result: PrintDemoRun | null;
	readonly failure: string | null;
};

export type PrintRunRefusal = "PRINT_RUNNING_LIMIT" | "PRINT_BUSY" | "PRINT_RATE_LIMITED" | "PRINT_STORE_FULL";

export type PrintRuns = {
	start(requesterId: string, farm: FarmMode): { readonly kind: "STARTED"; readonly record: PrintRunRecord } | { readonly kind: "REFUSED"; readonly code: PrintRunRefusal };
	get(id: string): PrintRunRecord | undefined;
};

/**
 * One run's work as the store starts it. `result` settles with the run's outcome. `stopped` settles once the work
 * has actually stopped, and only then does the run give up its slot. `terminate` stops the work now.
 */
export type PrintJob = {
	readonly result: Promise<PrintDemoRun>;
	readonly stopped: Promise<void>;
	terminate(): void;
};

export type PrintRunsDeps = {
	/** Starts one run's work. The server starts it in a worker thread that the store can stop. */
	readonly run: (input: RunInput) => PrintJob;
	readonly now: () => number;
	/** Fresh bytes for one run's seed. A test passes a fixed one. */
	readonly seed?: () => Uint8Array;
	/** The deadline per run. A test shortens it; the server keeps the default. */
	readonly deadlineMs?: number;
};

export function createPrintRuns(deps: PrintRunsDeps): PrintRuns {
	const records = new Map<string, PrintRunRecord>();
	const inFlightBy = new Map<string, number>();
	let inFlight = 0;
	const startsBy = new Map<string, number[]>();
	let counter = 0;

	/** Ends a RUNNING record. A record that already ended keeps its end, so a late deadline or result changes nothing. */
	const end = (id: string, change: Partial<PrintRunRecord>): boolean => {
		const current = records.get(id);
		if (current === undefined || current.state !== "RUNNING") return false;
		records.set(id, { ...current, ...change, endedAt: new Date(deps.now()).toISOString() });
		return true;
	};

	const evictOldestFinished = (): boolean => {
		for (const [id, record] of records) {
			if (record.state !== "RUNNING") {
				records.delete(id);
				return true;
			}
		}
		return false;
	};

	/** Frees one slot. It is called only once the run's work has stopped. */
	const release = (requesterId: string): void => {
		inFlight -= 1;
		const left = (inFlightBy.get(requesterId) ?? 1) - 1;
		if (left <= 0) inFlightBy.delete(requesterId);
		else inFlightBy.set(requesterId, left);
	};

	return {
		start(requesterId, farm) {
			const now = deps.now();
			const own = inFlightBy.get(requesterId) ?? 0;
			if (own >= PRINT_RUNNING_PER_REQUESTER) return { kind: "REFUSED", code: "PRINT_RUNNING_LIMIT" };
			if (inFlight >= PRINT_RUNNING_TOTAL) return { kind: "REFUSED", code: "PRINT_BUSY" };
			const recent = (startsBy.get(requesterId) ?? []).filter(at => now - at < HOUR_MS);
			if (recent.length >= PRINT_STARTS_PER_HOUR) return { kind: "REFUSED", code: "PRINT_RATE_LIMITED" };
			if (records.size >= PRINT_RUNS_KEPT && !evictOldestFinished()) return { kind: "REFUSED", code: "PRINT_STORE_FULL" };

			// Drop the starts of visitors with none left in the hour, so the map holds only recent visitors.
			for (const [who, times] of startsBy) {
				const live = times.filter(at => now - at < HOUR_MS);
				if (live.length === 0) startsBy.delete(who);
				else startsBy.set(who, live);
			}
			startsBy.set(requesterId, [...recent, now]);
			counter += 1;
			const id = `prt_${counter.toString(36)}_${randomBytes(6).toString("hex")}`;
			const record: PrintRunRecord = { id, requesterId, farm, state: "RUNNING", startedAt: new Date(now).toISOString(), endedAt: null, result: null, failure: null };
			records.set(id, record);

			let job: PrintJob;
			try {
				job = deps.run({ mode: farm, seed: deps.seed?.() ?? randomBytes(32), at: instantAt(now) });
			} catch {
				// No work started, so no slot is taken.
				end(id, { state: "FAILED", failure: "RUN_FAILED" });
				return { kind: "STARTED", record: records.get(id) ?? record };
			}

			inFlight += 1;
			inFlightBy.set(requesterId, own + 1);
			const deadline = setTimeout(() => {
				// The deadline ends the run now and stops its work. The slot stays taken until that work has stopped.
				if (end(id, { state: "FAILED", failure: "TIMED_OUT" })) job.terminate();
			}, deps.deadlineMs ?? PRINT_RUN_DEADLINE_MS);
			// The deadline alone does not keep the process alive; the server and a run's own worker do.
			deadline.unref();
			job.result.then(
				result => end(id, { state: "DONE", result }),
				() => end(id, { state: "FAILED", failure: "RUN_FAILED" }),
			);
			void job.stopped.then(() => {
				clearTimeout(deadline);
				release(requesterId);
			});
			return { kind: "STARTED", record };
		},
		get(id) {
			return records.get(id);
		},
	};
}

/**
 * One run's work in its own worker thread, started with the run's input. `result` settles with the worker's reply,
 * or fails when the worker errors, runs out of memory, or stops before it answers. `stopped` settles once the thread
 * has exited, and `terminate` stops the thread now.
 */
export function startPrintWorker(input: RunInput): PrintJob {
	const worker = new Worker(new URL("./print-worker.ts", import.meta.url), {
		workerData: input,
		resourceLimits: { maxOldGenerationSizeMb: PRINT_WORKER_HEAP_MB },
	});
	let answered = false;
	let finish!: (run: PrintDemoRun) => void;
	let fail!: (error: Error) => void;
	const result = new Promise<PrintDemoRun>((resolve, reject) => { finish = resolve; fail = reject; });
	let exited!: () => void;
	const stopped = new Promise<void>(resolve => { exited = resolve; });
	worker.on("message", (reply: PrintWorkerReply) => {
		if (answered) return;
		answered = true;
		if (reply.ok) finish(reply.run);
		else fail(new Error("the print run failed"));
	});
	worker.on("error", error => {
		if (answered) return;
		answered = true;
		fail(error);
	});
	worker.once("exit", () => {
		if (!answered) {
			answered = true;
			fail(new Error("the print worker stopped before it answered"));
		}
		exited();
	});
	return { result, stopped, terminate: () => { void worker.terminate(); } };
}

/** The refusal of a start the bounds turn away, as the status and code a client reads. */
const REFUSED_STATUS: Readonly<Record<PrintRunRefusal, number>> = {
	PRINT_RUNNING_LIMIT: 429,
	PRINT_BUSY: 503,
	PRINT_RATE_LIMITED: 429,
	PRINT_STORE_FULL: 503,
};

export type PrintReply = { readonly status: number; readonly body: unknown };

function refused(status: number, error: string, detail?: string): PrintReply {
	return { status, body: detail === undefined ? { error } : { error, detail } };
}

/** The record as a client reads it. It names the requester by nothing: the caller already knows who asked. */
function viewOf(record: PrintRunRecord): unknown {
	return { id: record.id, farm: record.farm, state: record.state, startedAt: record.startedAt, endedAt: record.endedAt, result: record.result, failure: record.failure };
}

/**
 * The print demo's two routes, answered for one signed-in visitor. POST starts a run for the farm it names and
 * answers at once with the run's record, still RUNNING. GET reads a run, and only the visitor that started it can
 * read it: another visitor's run answers the same 404 an unknown id does.
 */
export function printRunReply(runs: PrintRuns, requesterId: string, method: string, tail: string, input: unknown): PrintReply {
	if (method === "POST" && tail === "") {
		if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some(key => key !== "farm")) {
			return refused(400, "BAD_REQUEST", "Expected { farm }.");
		}
		const text = (input as { farm?: unknown }).farm;
		if (typeof text !== "string") return refused(400, "BAD_REQUEST", "farm must be a name such as honest or fraud:skip-infill.");
		const farm = parseFarmMode(text);
		if (farm === null) return refused(404, "UNKNOWN_FARM");
		const started = runs.start(requesterId, farm);
		if (started.kind === "REFUSED") return refused(REFUSED_STATUS[started.code], started.code);
		return { status: 201, body: viewOf(started.record) };
	}
	if (method === "GET" && tail.startsWith("/")) {
		const record = runs.get(tail.slice(1));
		if (record === undefined || record.requesterId !== requesterId) return refused(404, "NOT_FOUND");
		return { status: 200, body: viewOf(record) };
	}
	return refused(404, "NOT_FOUND");
}
