// The API's House delivery wiring: the scan builds each submit's actor from the job row's own
// tenant, and a provider rate/usage limit pauses the whole scan with a durable latch. Everything
// runs on injected ports: no Docker, no model call, no network, no checkout.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandOutcome, UserCommand } from "../../../packages/core/src/acquit.ts";
import type { JobId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { HOUSE_OPERATOR_ID, type HouseDelivery, type HouseRunOutcome, type HouseRunPlan, type HouseWorkPort } from "../../../packages/house/src/runner.ts";
import { createHouseDelivery } from "../src/house.ts";

/** A deliverable held House row, carrying exactly the fields the scan and its predicate read. */
function deliverableRow(jobId: string, tenant: string | null): JobRow {
	return {
		id: jobId, version: 1, client: "maya-client", tenant, title: "Totals round wrong for 3-decimal currencies",
		openedAt: "2026-10-12T00:00:00Z",
		contract: { budget: 400_00, deliveryEndsAt: "2026-10-14T00:00:00Z",
			definitionOfDone: { frozenAt: "a3b6ead29f4e367d1871e753b516cc9e832871e4", issue: { repository: "maya-client/invoice-app" } } },
		bids: [],
		state: { status: "IN_PROGRESS",
			escrow: { payee: { operator: HOUSE_OPERATOR_ID } },
			attempts: { phase: "READY", history: [], runsStarted: 0, failure: null } },
	} as unknown as JobRow;
}

function writeStateFile(stateDir: string, jobId: string, state: object): void {
	mkdirSync(join(stateDir, "house"), { recursive: true });
	writeFileSync(join(stateDir, "house", `${jobId}.json`), `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
}

/** A work port that answers without a checkout: prepare names a work dir, finalize mints one commit. */
function fakeWork(): HouseWorkPort {
	return {
		prepare: async () => ({ workDir: "/tmp/house-work" }),
		finalize: async () => ({
			commit: "5f5b7c0a9c0e1d2b3a4f5e6d7c8b9a0f1e2d3c4b" as HouseDelivery["commit"],
			files: [{ path: "src/totals.ts", added: 4, binary: false }], patch: "diff --git a/src/totals.ts b/src/totals.ts\n",
		}),
		remove: () => {},
	};
}

test("the House submits a visitor's job as the job's tenant, and a seeded job with none", async () => {
	for (const tenant of ["v_test", null]) {
		const stateDir = mkdtempSync(join(tmpdir(), "acquit-house-api-"));
		try {
			const jobId = "job_house_tenant";
			// A series that already holds a commit rides the re-submit path: no checkout, no model run.
			writeStateFile(stateDir, jobId, { calls: 1, submittedCommit: "a".repeat(40), submitAttempts: 0, prepareFailures: 0 });
			const actors: unknown[] = [];
			const commands: UserCommand[] = [];
			const house = createHouseDelivery({
				jobs: () => [deliverableRow(jobId, tenant)],
				mint: async () => ({ repository: "acquit-forks/invoice-app-x", token: "GHT-TEST-TOKEN" }),
				execute: async (actor, command) => {
					actors.push(actor);
					commands.push(command);
					return { kind: "COMMITTED", result: { kind: "JOB", job: { id: jobId } } } as unknown as CommandOutcome;
				},
				recordDiff: async () => {},
				stateDir,
				env: { ACQUIT_HOUSE_COMMAND: "/srv/house/fix.sh" },
			});
			await house.kick();
			assert.deepEqual(actors, [{ role: "OPERATOR", operatorId: HOUSE_OPERATOR_ID, tenant }],
				`the House submits ${String(tenant)}'s job inside that job's own tenant`);
			assert.deepEqual(commands.map(command => command.type), ["Submit"]);
		} finally { rmSync(stateDir, { recursive: true, force: true }); }
	}
});

/** Two held House rows the scan walks in order; the run port records every plan it is handed. */
function twoJobHouse(stateDir: string, run: (plan: HouseRunPlan) => Promise<HouseRunOutcome>) {
	const plans: HouseRunPlan[] = [];
	const house = createHouseDelivery({
		jobs: () => [deliverableRow("job_house_first", "v_test"), deliverableRow("job_house_second", null)],
		mint: async () => ({ repository: "acquit-forks/invoice-app-x", token: "GHT-TEST-TOKEN" }),
		execute: async () => ({ kind: "COMMITTED", result: { kind: "JOB", job: { id: "" } } } as unknown as CommandOutcome),
		recordDiff: async () => {},
		stateDir,
		run: async plan => { plans.push(plan); return run(plan); },
		work: fakeWork(),
		env: { ACQUIT_HOUSE_COMMAND: "/srv/house/fix.sh" },
	});
	return { house, plans };
}

test("a rate-limited first job stops the scan: one call in total, and the second job is not dispatched", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "acquit-house-api-"));
	try {
		const limited = async (): Promise<HouseRunOutcome> => ({ ok: false, reason: "RATE_LIMITED", detail: "usage limit reached" });
		const first = twoJobHouse(stateDir, limited);
		await first.house.kick();
		assert.equal(first.plans.length, 1, "the scan stops at the rate-limited job");
		const latch = join(stateDir, "house", "paused.json");
		assert.equal(existsSync(latch), true, "the pause is latched durably");
		const paused = JSON.parse(readFileSync(latch, "utf8")) as { reason?: string; jobId?: string };
		assert.equal(paused.reason, "RATE_LIMITED");
		assert.equal(paused.jobId, "job_house_first");
		assert.equal(statSync(latch).mode & 0o777, 0o600, "the latch is mode 600");

		const second = twoJobHouse(stateDir, limited);
		await second.house.kick();
		assert.equal(second.plans.length, 0, "no job is dispatched while the latch exists");
	} finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("a spent call budget stops the scan for this tick without a latch", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "acquit-house-api-"));
	try {
		// The deployment's call log beside the database, already holding a full minute window.
		const at = new Date().toISOString();
		const starts = Array.from({ length: 19 }, () =>
			`${JSON.stringify({ at, caller: "house", jobId: "job_house_other", provider: "droid", model: "glm-5.3-flash", phase: "START" })}\n`).join("");
		writeFileSync(join(stateDir, "model-calls.jsonl"), starts, { mode: 0o600 });
		const house = twoJobHouse(stateDir, async () => { throw new Error("no run may start on a spent budget"); });
		await house.house.kick();
		assert.equal(house.plans.length, 0, "no model call starts on a spent budget");
		assert.equal(existsSync(join(stateDir, "house", "paused.json")), false, "a budget pause is not a latch");
		assert.equal(readdirSync(join(stateDir, "house")).includes("job_house_first.json"), false, "the job's call count never moved");
	} finally { rmSync(stateDir, { recursive: true, force: true }); }
});
