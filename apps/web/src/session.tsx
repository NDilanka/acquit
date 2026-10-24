import { createContext, useContext } from "react";
import type { AccountView, FundingMode, SessionUser } from "./api-types";

/** A signed-in browser. `account` is set only for a Try Acquit account, never for a seeded or platform session. */
export type Session = { readonly user: SessionUser; readonly account: AccountView | null };

/** `fundingMode` is the deployment's default, read once when the app loads; a job's own choice wins over it. */
export const SessionContext = createContext<(Session & { signOut: () => void; fundingMode: FundingMode }) | null>(null);

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
