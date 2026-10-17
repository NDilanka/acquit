// A failed step records a closed code. An error that carries one keeps it as the outcome and logs nothing. An
// error without one records STEP_FAILED and logs its message once, with the run and the step named and the
// credentials in it masked, so the stored outcome and the log never hold a provider's secret.

import assert from "node:assert/strict";
import test from "node:test";
import type { ScenarioRun, ScenarioWorkspace } from "../src/scenarios.ts";
import { ScenarioRefused, startScenario } from "../src/scenarios.ts";
import type { Harness } from "./scenario-harness.ts";
import { harness } from "./scenario-harness.ts";

/** Runs verified-and-paid on the harness's visitor, with its push answered by the given workspace, and waits for the end. */
async function runWith(h: Harness, workspace: ScenarioWorkspace): Promise<ScenarioRun> {
	const admitted = h.deps.runs.admit(h.visitor.id);
	if (admitted.kind !== "ADMITTED") throw new Error(`admission refused: ${admitted.code}`);
	const started = await startScenario({ ...h.deps, workspace }, "verified-and-paid", h.visitor, h.visitor.id, admitted.slot);
	return started.finished;
}

test("a refusal keeps its code as the step outcome, and nothing is logged", async t => {
	const h = await harness();
	const errors = t.mock.method(console, "error", () => {});
	try {
		const run = await runWith(h, { push: async () => { throw new ScenarioRefused("SCENARIO_FIXTURE_INCOMPATIBLE", "the frozen suite cannot be scripted"); } });
		assert.equal(run.state, "FAILED");
		assert.equal(run.steps.at(-1)?.name, "push-honest-reference-table");
		assert.equal(run.steps.at(-1)?.outcome, "FAILED SCENARIO_FIXTURE_INCOMPATIBLE");
		assert.equal(errors.mock.callCount(), 0);
	} finally { await h.dispose(); }
});

test("an error that carries a closed code keeps it as the step outcome, and nothing is logged", async t => {
	const h = await harness();
	const errors = t.mock.method(console, "error", () => {});
	try {
		const coded = Object.assign(new Error("the provider refused"), { code: "JOB_CHANGED" });
		const run = await runWith(h, { push: async () => { throw coded; } });
		assert.equal(run.steps.at(-1)?.outcome, "FAILED JOB_CHANGED");
		assert.equal(errors.mock.callCount(), 0);
	} finally { await h.dispose(); }
});

test("an uncoded error records FAILED STEP_FAILED and logs one line naming the run and the step", async t => {
	const h = await harness();
	const errors = t.mock.method(console, "error", () => {});
	try {
		const run = await runWith(h, { push: async () => { throw new Error("the push was refused"); } });
		assert.equal(run.steps.at(-1)?.outcome, "FAILED STEP_FAILED");
		assert.equal(errors.mock.callCount(), 1);
		assert.deepEqual(errors.mock.calls[0].arguments, [`scenario run ${run.id} step push-honest-reference-table failed: the push was refused`]);
	} finally { await h.dispose(); }
});

test("the logged message of an uncoded error masks the credentials in it", async t => {
	const h = await harness();
	const errors = t.mock.method(console, "error", () => {});
	const sentinels = ["sentinel-app-token-value", "sentinel-bearer-value", "sentinel-url-password"];
	try {
		const leaked = ["token=sentinel-app-token-value", "Authorization: Bearer sentinel-bearer-value-0000",
			"https://x-access-token:sentinel-url-password@github.com/owner/repo.git"];
		const run = await runWith(h, { push: async () => { throw new Error(`git push failed: ${leaked.join(" ")}`); } });
		assert.equal(run.steps.at(-1)?.outcome, "FAILED STEP_FAILED");
		assert.equal(errors.mock.callCount(), 1);
		const line = String(errors.mock.calls[0].arguments[0]);
		assert.ok(line.startsWith(`scenario run ${run.id} step push-honest-reference-table failed: git push failed:`), line);
		for (const secret of sentinels) assert.equal(line.includes(secret), false, `the log holds ${secret}`);
	} finally { await h.dispose(); }
});
