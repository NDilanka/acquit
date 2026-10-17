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
