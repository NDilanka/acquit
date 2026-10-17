import type { ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

/**
 * The platform dashboards' live signal. SQLite's data_version moves when another connection commits, so
 * a write from the core's own connection (a webhook, a House delivery, a verdict) reaches every open stream
 * without the core knowing the stream exists. The stream carries no data: each "changed" event tells the
 * page to read the platform routes again.
 */
const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

export type PlatformStream = {
	/** Holds the response open; each commit by another connection sends one "changed" event. */
	open(res: ServerResponse): void;
	/** Ends every open stream, so a server that is closing is not held open by a dashboard. */
	close(): void;
};

export function platformStream(db: DatabaseSync, now: () => string): PlatformStream {
	const clients = new Set<ServerResponse>();
	const version = db.prepare("PRAGMA data_version");
	let seen: number | null = null;
	let poll: ReturnType<typeof setInterval> | undefined;
	let beat: ReturnType<typeof setInterval> | undefined;

	const dataVersion = (): number => Number((version.get() as { data_version: number }).data_version);
	const broadcast = (frame: string): void => { for (const res of clients) res.write(frame); };

	function tick(): void {
		const current = dataVersion();
		if (current === seen) return;
		seen = current;
		broadcast(`data: ${JSON.stringify({ kind: "changed", at: now() })}\n\n`);
	}

	function start(): void {
		seen = dataVersion();
		poll = setInterval(tick, POLL_MS);
		beat = setInterval(() => broadcast(": heartbeat\n\n"), HEARTBEAT_MS);
	}

	function stop(): void {
		clearInterval(poll);
		clearInterval(beat);
		poll = undefined;
		beat = undefined;
		seen = null;
	}

	return {
		open(res) {
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write("retry: 2000\n\n");
			clients.add(res);
			if (clients.size === 1) start();
			// The response's own close, not the request's: a GET's request is consumed before the stream ends.
			res.on("close", () => {
				clients.delete(res);
				if (clients.size === 0) stop();
			});
		},
		close() {
			for (const res of clients) res.end();
			clients.clear();
			stop();
		},
	};
}
