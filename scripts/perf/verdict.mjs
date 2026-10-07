// The cli probe's exit verdict, separate from the process so the decision is unit-testable: one
// report in, one pass or fail out, and `process.exitCode` reads it.

/**
 * A probe that blocked anywhere fails, whatever metrics it reached before the block; in runStart-only
 * mode the runStart metric is the only number, and a metric the probe could not measure (a blocked
 * metric with passed null) never fails the run by itself.
 */
export function probePassed(report) {
	if (report.blocked !== null) return false;
	return report.runOnly
		? report.runStart?.passed !== false
		: report.help?.passed === true && report.jobsList?.passed === true && report.runStart?.passed !== false;
}
