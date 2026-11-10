import { useCallback, useEffect, useRef, useState } from "react";

export type Loaded<T> = {
  /** The last good data, or null until the first read succeeds. */
  readonly data: T | null;
  /** The last failed read. Cleared by the next read that succeeds. */
  readonly error: unknown;
  readonly reload: () => void;
};

/** Reads once on mount, and again when `key` changes or `reload` is called. A late answer from an older read is dropped. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const ticket = ++latest.current;
    load().then(
      (next) => {
        if (ticket !== latest.current) return;
        setData(next);
        setError(null);
      },
      (e: unknown) => {
        if (ticket === latest.current) setError(e);
      },
    );
    // `key` names the inputs the loader reads, so a new key means a new read.
  }, [key]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, reload };
}
