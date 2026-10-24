/**
 * A fixed-window count of attempts per key: true admits one more, false refuses until the key's window ends. Memory
 * holds one entry per key seen in a live window, and spent windows are dropped once the map grows large.
 */
export function attemptLimiter(limit: number, windowMs: number, now: () => number = Date.now): (key: string) => boolean {
	const windows = new Map<string, { start: number; count: number }>();
	return key => {
		const at = now();
		if (windows.size > 10_000) for (const [seen, window] of windows) if (at - window.start >= windowMs) windows.delete(seen);
		const current = windows.get(key);
		if (current === undefined || at - current.start >= windowMs) { windows.set(key, { start: at, count: 1 }); return true; }
		if (current.count >= limit) return false;
		current.count++;
		return true;
	};
}

/** How many restores one address may try in one window. A person pasting a saved link needs one or two. */
export const RESTORE_ATTEMPTS = 10;
export const RESTORE_WINDOW_MS = 15 * 60_000;
