/** Page-lifetime capability cache. Reloading the page creates a fresh reader. */
export function activityReader<T>(read: (limit?: number) => Promise<T | null>) {
  let missing = false;
  const pending = new Map<string,Promise<T | null>>();
  return (limit?: number, principal = ""): Promise<T | null> => {
    if (missing) return Promise.resolve(null);
    const key = JSON.stringify([principal,limit]);
    const current = pending.get(key);
    if (current) return current;
    const result = Promise.resolve().then(() => read(limit)).then(value => {
      if (value === null) missing = true;
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key,result);
    return result;
  };
}
