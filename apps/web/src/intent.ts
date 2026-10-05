import { useRef, useState } from "react";
import type { CommandOutcome, UserCommand } from "./api-types";
import { api, ApiError } from "./api";
import { denied } from "./format";

type Pending = { signature: string; key: string; command: UserCommand };

export type Committed = Extract<CommandOutcome, { kind: "COMMITTED" | "REPLAY" }>;

/**
 * One request key per user intent. A retry with the same form values reuses the key and the
 * exact command (including any timestamp computed at first submit), so the API can replay it.
 * Changing the values starts a new intent.
 */
export function useIntent() {
  const pending = useRef<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(signature: string, build: () => UserCommand): Promise<Committed | null> {
    if (pending.current?.signature !== signature) {
      pending.current = { signature, key: crypto.randomUUID(), command: build() };
    }
    const { key, command } = pending.current;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.command(key, command);
      if (outcome.kind === "DENIED") {
        pending.current = null;
        setError(denied(outcome.reason));
        return null;
      }
      pending.current = null;
      return outcome;
    } catch (e) {
      // Network or server failure: keep the key so the next click is a safe retry.
      setError(e instanceof ApiError ? e.message : `Network error: ${String(e)}. Retry is safe.`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { send, busy, error, setError };
}
