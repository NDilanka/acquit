// The PayPal check at work start. When a funded job's agent first pushes, the deployment asks PayPal's API whether the
// order's capture is still held, and records the answer on the job: the order, the status PayPal returned, the amount
// PayPal reports held, and the time. It only observes and records. The check starts beside the push and nothing waits
// for it, so a slow or refused read records the check as unavailable and the run goes on exactly as it would without it.

import type { DatabaseSync } from "node:sqlite";
import type { MerchantId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { authAssertion } from "../../../packages/core/src/paypal.ts";
import { paypalReader, PayPalHttpError, type PaypalReader } from "../../../packages/mcp/src/paypal.ts";

/** How long the read may take. A read still running at this point records the check as unavailable. */
export const PAYPAL_CHECK_TIMEOUT_MS = 5_000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS job_paypal_checks (
	job_id TEXT PRIMARY KEY,
	order_id TEXT NOT NULL,
	checked_at TEXT NOT NULL,
	outcome TEXT NOT NULL,
	order_status TEXT,
	capture_status TEXT,
	held_value TEXT,
	held_currency TEXT,
	reason TEXT
)`;

/** HELD: PayPal's capture is COMPLETED. NOT_HELD: PayPal answered and the money is not held. UNAVAILABLE: no usable answer. */
export type PayPalCheckOutcome = "HELD" | "NOT_HELD" | "UNAVAILABLE";

/** One recorded check. `heldValue` and `heldCurrency` are PayPal's own amount, a decimal string such as "42.00". */
export type PayPalCheck = {
	readonly jobId: string;
	readonly orderId: string;
	readonly checkedAt: string;
	readonly outcome: PayPalCheckOutcome;
	readonly orderStatus: string | null;
	readonly captureStatus: string | null;
	readonly heldValue: string | null;
	readonly heldCurrency: string | null;
	readonly reason: string | null;
};

/** One GET of an order under its merchant's assertion. It resolves the order's JSON and rejects when the read fails. */
export type OrderRead = (orderId: string, merchant: MerchantId) => Promise<unknown>;

type Answer = Omit<PayPalCheck, "jobId" | "orderId" | "checkedAt">;

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const firstOf = (value: unknown): Record<string, unknown> => record(Array.isArray(value) ? value[0] : undefined);
const text = (value: unknown): string | null => typeof value === "string" ? value : null;

/**
 * What PayPal's order answer says about the money. HELD: the order's first capture is COMPLETED, and PayPal reports its
 * amount. NOT_HELD: PayPal answered and the capture is not completed. Anything else is UNAVAILABLE.
 */
export function answerOf(json: unknown, orderId: string): Answer {
	const order = record(json);
	if (order.id !== orderId) return unavailable("ORDER_MISMATCH");
	const unit = firstOf(order.purchase_units);
	const capture = firstOf(record(unit.payments).captures);
	const amount = record(capture.amount);
	const captureStatus = text(capture.status);
	const orderStatus = text(order.status);
	if (captureStatus === "COMPLETED") {
		const value = text(amount.value);
		const currency = text(amount.currency_code);
		if (value === null || currency === null) return unavailable("AMOUNT_MISSING");
		return { outcome: "HELD", orderStatus, captureStatus, heldValue: value, heldCurrency: currency, reason: null };
	}
	return { outcome: "NOT_HELD", orderStatus, captureStatus, heldValue: null, heldCurrency: null,
		reason: captureStatus !== null ? `CAPTURE_${captureStatus}` : `ORDER_${orderStatus ?? "UNKNOWN"}` };
}

function unavailable(reason: string): Answer {
	return { outcome: "UNAVAILABLE", orderStatus: null, captureStatus: null, heldValue: null, heldCurrency: null, reason };
}

/** The deployment's order reader: one GET of the order under its merchant's assertion, the way the core reads orders. */
export function paypalOrderRead(config: { readonly clientId: string; readonly clientSecret: string }, fetchImpl: typeof fetch = fetch): OrderRead {
	let reader: Promise<PaypalReader> | null = null;
	return async (orderId, merchant) => {
		reader ??= paypalReader({ ...config, sandbox: true }, fetchImpl);
		return (await reader).get(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, authAssertion(config.clientId, merchant));
	};
}

class CheckTimeout extends Error {}

/** The read's answer, or a CheckTimeout once `ms` passes. The read itself is never cancelled; its late answer is dropped. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CheckTimeout("timeout")), ms); });
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function failureOf(error: unknown): Answer {
	if (error instanceof CheckTimeout) return unavailable("TIMEOUT");
	if (error instanceof PayPalHttpError) return unavailable(`PAYPAL_HTTP_${error.status}`);
	return unavailable("READ_FAILED");
}

export type PayPalCheckPorts = {
	readonly db: DatabaseSync;
	/** Absent when the deployment has no PayPal credentials. Then no check starts and nothing is recorded. */
	readonly read: OrderRead | null;
	readonly now: () => string;
	readonly timeoutMs?: number;
	readonly log?: (line: string) => void;
};

/**
 * The check's start and its reads. `start` returns at once: the read runs on its own, and its answer is recorded when
 * it settles. A job is checked once. A start for a job whose read is running, or that already has a record, starts no read.
 */
export function createPayPalCheck(ports: PayPalCheckPorts): {
	readonly start: (row: JobRow) => void;
	readonly recordsOf: (jobIds: readonly string[]) => ReadonlyMap<string, PayPalCheck>;
} {
	ports.db.exec(SCHEMA);
	const log = ports.log ?? ((line: string) => console.log(line));
	const timeoutMs = ports.timeoutMs ?? PAYPAL_CHECK_TIMEOUT_MS;
	const inFlight = new Set<string>();
	const recorded = ports.db.prepare("SELECT 1 FROM job_paypal_checks WHERE job_id = ?");
	const insert = ports.db.prepare(`INSERT OR IGNORE INTO job_paypal_checks
		(job_id, order_id, checked_at, outcome, order_status, capture_status, held_value, held_currency, reason)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	const select = ports.db.prepare(`SELECT job_id, order_id, checked_at, outcome, order_status, capture_status,
		held_value, held_currency, reason FROM job_paypal_checks WHERE job_id = ?`);

	async function check(jobId: string, orderId: string, merchant: MerchantId, read: OrderRead): Promise<void> {
		let answer: Answer;
		try { answer = answerOf(await within(read(orderId, merchant), timeoutMs), orderId); }
		catch (error) { answer = failureOf(error); }
		try {
			insert.run(jobId, orderId, ports.now(), answer.outcome, answer.orderStatus, answer.captureStatus,
				answer.heldValue, answer.heldCurrency, answer.reason);
			log(`PayPal check for ${jobId}: ${answer.outcome}${answer.reason === null ? "" : ` (${answer.reason})`}`);
		} catch (error) {
			log(`PayPal check for ${jobId} was not recorded: ${error instanceof Error ? error.name : "error"}`);
		}
	}

	return {
		start(row) {
			try {
				if (ports.read === null || row.state.status !== "IN_PROGRESS") return;
				const jobId = row.id as string;
				if (inFlight.has(jobId) || recorded.get(jobId) !== undefined) return;
				inFlight.add(jobId);
				const { escrow } = row.state;
				void check(jobId, escrow.capture.orderId, escrow.payee.payee, ports.read)
					.finally(() => inFlight.delete(jobId));
			} catch (error) {
				log(`PayPal check did not start: ${error instanceof Error ? error.name : "error"}`);
			}
		},
		recordsOf(jobIds) {
			const records = new Map<string, PayPalCheck>();
			for (const jobId of jobIds) {
				const row = select.get(jobId) as Record<string, string | null> | undefined;
				if (row === undefined) continue;
				records.set(jobId, {
					jobId: row.job_id as string, orderId: row.order_id as string, checkedAt: row.checked_at as string,
					outcome: row.outcome as PayPalCheckOutcome, orderStatus: row.order_status, captureStatus: row.capture_status,
					heldValue: row.held_value, heldCurrency: row.held_currency, reason: row.reason,
				});
			}
			return records;
		},
	};
}
