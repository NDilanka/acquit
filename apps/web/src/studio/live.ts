import type { PlatformStreamEvent } from "../api-types";

/** Same origin, so the session cookie rides with the stream. */
export const PLATFORM_STREAM_PATH = "/api/platform/stream";

/** The plain poll the page falls back to only when the stream is unavailable. */
export const FALLBACK_POLL_MS = 30_000;

/** The event a data line carries, or null for anything else. Heartbeats are comments and never reach the handler. */
export function parseStreamEvent(data: string): PlatformStreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { kind, at } = value as { kind?: unknown; at?: unknown };
  return kind === "changed" && typeof at === "string" ? { kind: "changed", at } : null;
}

/**
 * Reads of the platform routes run one at a time. A change, or a reconnect, that lands during a read queues
 * exactly one more read, so a burst of commits costs at most two reads and the last one starts after the last change.
 */
export type ReadState = { readonly reading: boolean; readonly again: boolean };
export const READ_IDLE: ReadState = { reading: false, again: false };

/** A change arrived: start a read now, or queue one behind the read in flight. */
export function onChange(state: ReadState): { state: ReadState; read: boolean } {
  return state.reading ? { state: { reading: true, again: true }, read: false } : { state: { reading: true, again: false }, read: true };
}

/** A read settled: run the queued read, or go idle. */
export function onSettled(state: ReadState): { state: ReadState; read: boolean } {
  return state.again ? { state: { reading: true, again: false }, read: true } : { state: READ_IDLE, read: false };
}

/** How the page hears about changes: the stream is open, the browser is retrying it, or it gave up and the page polls. */
export type Transport = "live" | "reconnecting" | "polling";

/** What the escrow book on screen rests on: the last good read, and the read that failed after it, if any. */
export type Book = { readonly lastGoodAt: string | null; readonly failure: { readonly at: string; readonly error: string } | null };
export const BOOK_EMPTY: Book = { lastGoodAt: null, failure: null };

export type ReadOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** A good read makes the book fresh as of `at`. A failed read keeps the last good figures and marks the failure. */
export function bookRead(book: Book, outcome: ReadOutcome, at: string): Book {
  return outcome.ok ? { lastGoodAt: at, failure: null } : { lastGoodAt: book.lastGoodAt, failure: { at, error: outcome.error } };
}

/** Figures from an earlier read are on screen while the latest read failed. */
export function isStale(book: Book): boolean {
  return book.lastGoodAt !== null && book.failure !== null;
}

/** A clock time such as 14:02:10, in the named zone or the browser's. */
export function clockTime(at: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at));
}

export type FreshnessNotice = { readonly tone: "warn"; readonly text: string };

/**
 * The note under the dashboard header, or null when nothing is wrong. A failed refresh outranks the stream state.
 * With no good read yet there are no figures that could be behind, so the first-load error alert speaks alone.
 */
export function freshnessNotice(transport: Transport, book: Book, timeZone?: string): FreshnessNotice | null {
  if (book.lastGoodAt === null) return null;
  if (book.failure !== null) {
    // Errors often end in a period, and the notice adds its own.
    const error = book.failure.error.replace(/\.$/, "");
    return {
      tone: "warn",
      text: `Showing figures from ${clockTime(book.lastGoodAt, timeZone)}. The latest refresh failed: ${error}. Retrying every ${FALLBACK_POLL_MS / 1000} seconds.`,
    };
  }
  if (transport === "reconnecting") return { tone: "warn", text: "Live updates dropped. Reconnecting; figures may be behind." };
  return null;
}
