import { useEffect, useState } from "react";
import { useSession } from "../../session.tsx";
import { specialists } from "./client.ts";
import { sinceIso } from "./view.ts";
import { useLoad } from "./useLoad.ts";

export function useReport(markRead = false) {
  const { user } = useSession();
  const [cursor] = useState(() => {
    const openedAt = new Date().toISOString();
    const key = `acquit.earningsRead:${user.handle}`;
    let since = sinceIso(Date.now());
    try {
      const previous = localStorage.getItem(key);
      if (previous && Number.isFinite(Date.parse(previous)) && previous <= openedAt) since = previous;
    } catch { /* Storage is optional. */ }
    return { key, openedAt, since };
  });
  const report = useLoad(() => specialists.morningReport(cursor.since), cursor.since);
  useEffect(() => {
    if (!markRead || !report.data) return;
    try { localStorage.setItem(cursor.key, cursor.openedAt); } catch { /* Storage is optional. */ }
  }, [markRead, report.data, cursor]);
  return { ...report, cursor };
}
