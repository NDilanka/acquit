import assert from "node:assert/strict";
import test from "node:test";

type Report = { runOnly: unknown; blocked: string | null; help?: { passed: boolean } | null;
	jobsList?: { passed: boolean } | null; runStart?: { passed: boolean | null } | null };
const { probePassed } = await import(new URL("../../../scripts/perf/verdict.mjs", import.meta.url).href) as {
	probePassed: (report: Report) => boolean;
};

const full = (overrides: Partial<Report> = {}): Report => ({ runOnly: null, blocked: null,
	help: { passed: true }, jobsList: { passed: true }, runStart: { passed: true }, ...overrides });

test("a full run that blocked anywhere fails even when every metric it reached passed", () => {
	assert.equal(probePassed(full({ blocked: "PROBE_FAILED" })), false);
	assert.equal(probePassed(full({ blocked: "RUN_START_FAILED" })), false);
});

test("a full run passes only when it blocked nowhere and both hard metrics passed", () => {
	assert.equal(probePassed(full()), true);
	assert.equal(probePassed(full({ help: { passed: false } })), false);
	assert.equal(probePassed(full({ jobsList: { passed: false } })), false);
	// A runStart the probe could not measure (no funded job, Docker, or image) is a blocked metric,
	// never a failed number, so it does not fail the run by itself.
	assert.equal(probePassed(full({ runStart: { passed: null } })), true);
	assert.equal(probePassed(full({ runStart: { passed: false } })), false);
});

test("a runStart-only probe fails only when it blocked or measured over the rule", () => {
	const runOnly = { lane: 16, jobId: "job_7Q2K" };
	assert.equal(probePassed({ runOnly, blocked: null, runStart: { passed: true } }), true);
	assert.equal(probePassed({ runOnly, blocked: null, runStart: { passed: false } }), false);
	assert.equal(probePassed({ runOnly, blocked: null, runStart: { passed: null } }), true);
	assert.equal(probePassed({ runOnly, blocked: "RUN_LANE_UNREACHABLE", runStart: null }), false);
});
