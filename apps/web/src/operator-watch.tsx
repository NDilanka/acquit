import { useEffect, useState } from "react";
import { api } from "./api";
import type { SessionUser } from "./api-types";
import { deliveryCount, JOBS_CHANGED, operatorEvents, readSeen, unseenEvents, WATCH_MS, writeSeen } from "./operator-events";
import { useToast } from "./toast";

/**
 * While an operator is signed in, reads their jobs every few seconds. A won bid or a payment shows one toast on
 * whatever page is open, never again after a reload, and the answer is the My work badge.
 */
export function useOperatorWatch(user: SessionUser | null): number {
  const toast = useToast();
  const [badge, setBadge] = useState(0);
  const role = user?.role ?? null;
  const handle = user?.handle ?? null;

  useEffect(() => {
    setBadge(0);
    if (role !== "OPERATOR" || handle === null) return;
    let stopped = false;
    const check = async () => {
      try {
        const { jobs } = await api.jobs();
        if (stopped) return;
        setBadge(deliveryCount(jobs, handle));
        const { fresh, seen } = unseenEvents(operatorEvents(jobs, handle), readSeen(localStorage, handle));
        writeSeen(localStorage, handle, seen);
        const latest = fresh.at(-1);
        if (latest) {
          toast(latest.message);
          window.dispatchEvent(new Event(JOBS_CHANGED));
        }
      } catch {
        // A failed read waits for the next one.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), WATCH_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [role, handle, toast]);

  return badge;
}
