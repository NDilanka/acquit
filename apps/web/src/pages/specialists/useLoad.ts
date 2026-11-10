import { useCallback, useEffect, useRef, useState } from "react";

export type Loaded<T> = {
  /** The last good data, or null until the first read succeeds. */
  readonly data: T | null;
  /** The last failed read. Cleared by the next read that succeeds. */
  readonly error: unknown;
  readonly reload: () => void;
};

type Snapshot<T> = { readonly key: string; readonly data: T | null; readonly error: unknown };
export function loadForKey<T>(snapshot: Snapshot<T>, key: string): Pick<Loaded<T>, "data" | "error"> {
  return snapshot.key === key ? { data:snapshot.data,error:snapshot.error } : { data:null,error:null };
}

/** Reads once on mount, and again when `key` changes or `reload` is called. A late answer from an older read is dropped. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ key,data:null,error:null });
  const latest = useRef(0);

  const reload = useCallback(() => {
    const ticket = ++latest.current;
    load().then(
      (next) => {
        if (ticket !== latest.current) return;
        setSnapshot({ key,data:next,error:null });
      },
      (e: unknown) => {
        if (ticket === latest.current) setSnapshot(previous => ({ key,data:previous.key === key ? previous.data : null,error:e }));
      },
    );
    // `key` names the inputs the loader reads, so a new key means a new read.
  }, [key]);

  useEffect(() => {
    reload();
    return () => { latest.current++; };
  }, [reload]);

  return { ...loadForKey(snapshot,key),reload };
}
