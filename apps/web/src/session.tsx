import { createContext, useContext } from "react";
import type { SessionUser, VisitorView } from "./api-types";

/** A signed-in browser. `visitor` is set only for a judge-mode demo session. */
export type Session = { readonly user: SessionUser; readonly visitor: VisitorView | null };

export const SessionContext = createContext<(Session & { signOut: () => void }) | null>(null);

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside a signed-in tree");
  return ctx;
}

const KEY = "acquit.myJobs";

/** Job ids opened from this browser, so the dashboard can show them after they leave OPEN. */
export function rememberJob(handle: string, id: string) {
  const all = readAll();
  const mine = new Set(all[handle] ?? []);
  mine.add(id);
  all[handle] = [...mine];
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function rememberedJobs(handle: string): string[] {
  return readAll()[handle] ?? [];
}

function readAll(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}
