import { resolve } from "node:path";
import { laneSlot } from "../../packages/ctl/src/state.ts";

/**
 * The probe owns its own lanes. A lane keeps the probe's run file, database, and ports
 * out of the worktree's default slot, so a dev app already running in the same worktree
 * shares no state with the probe and can never be addressed or stopped by it.
 */
export const probeLanes = { trunk: 61, head: 62 };

export function probeSide(label, root) {
	const lane = laneSlot(probeLanes[label]);
	return { label, lane: probeLanes[label], api: lane.apiPort, web: lane.webPort, databasePath: resolve(root, lane.databasePath) };
}

/**
 * Admit only a freshly started side that reports its own ports and database. `start`
 * exits 0 with alreadyRunning true when a recorded run file already answers, and
 * tracking that side would let cleanup stop an app this probe never started.
 */
export function admitStartedSide(side, stdout) {
	const report = JSON.parse(stdout);
	const data = report?.data ?? {};
	const urls = { api: `http://localhost:${side.api}`, web: `http://localhost:${side.web}` };
	if (report?.ok !== true || typeof data.databasePath !== "string") throw new Error(`${side.label} start did not report a run: ${stdout.trim()}`);
	if (data.alreadyRunning !== false) throw new Error(`${side.label} start reported an app already running; refusing to track or stop it.`);
	if (data.urls?.api !== urls.api || data.urls?.web !== urls.web) throw new Error(`${side.label} start reported ${JSON.stringify(data.urls)}; expected its own ports ${JSON.stringify(urls)}.`);
	if (resolve(data.databasePath).toLowerCase() !== side.databasePath.toLowerCase()) throw new Error(`${side.label} start reported database ${data.databasePath}; expected ${side.databasePath}.`);
	return data;
}

/** Stop every tracked side and collect the problems, so one failed stop cannot skip another. */
export async function stopProbeSides(sides, stopSide) {
	const problems = [];
	for (const side of sides) {
		try {
			const result = await stopSide(side);
			const open = result.open ?? [];
			if (result.code !== 0) problems.push(`${side.label} stop exited ${result.code}`);
			if (open.length) problems.push(`${side.label} ports still open: ${open.join(", ")}`);
		} catch (error) {
			problems.push(`${side.label} stop failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return problems;
}

/**
 * Run the measurement, then clean up. A cleanup problem never masks the measurement's
 * own error, so a failed stop cannot hide why the run failed.
 */
export async function withProbeCleanup(measure, sides, stopSide) {
	let failure;
	try {
		return await measure();
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		const problems = await stopProbeSides(sides, stopSide);
		if (failure) {
			if (problems.length) console.error(`Ledger probe cleanup also failed: ${problems.join("; ")}`);
		} else if (problems.length) throw new Error(`Ledger probe cleanup failed: ${problems.join("; ")}`);
	}
}
