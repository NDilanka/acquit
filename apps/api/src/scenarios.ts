// The scenario routes' server side. A signed-in visitor starts one of the five judge scenarios and reads
// its run. Each start provisions the run its own visitor, so one session can start all five, and each run
// keeps its own job, repository, and work repo. The run lives on the server, so a closed tab does not stop
// it. Its steps act through the core as the run visitor's own actors, and its scripted tree is written onto
// the job's frozen checkout, so the real judge judges what the scenario names.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Acquit, DemoVisitorResult } from "../../../packages/core/src/acquit.ts";
import { defaultJobFunding } from "../../../packages/core/src/funding.ts";
import { fixtureKey } from "../../../packages/core/src/fixtures.ts";
import type { FixtureContract } from "../../../packages/core/src/fixtures.ts";
import type { Instant, JobId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { CORPUS, FROZEN_TEST_PATH, frozenSuiteMatchesCorpus } from "../../../packages/core/src/score-card-trees.ts";
import { isScenarioName, ScenarioRefused, scenarioNeedsDev, startScenario } from "../../../packages/core/src/scenarios.ts";
import type { ScenarioDeps, ScenarioRuns, ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import type { SqliteStore } from "../../../packages/core/src/store.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import type { HouseTarget, HouseWorkPort } from "../../../packages/house/src/runner.ts";

/** The fixture every judge scenario opens on: the repository and issue its registry entry names. */
export type ScenarioFixture = { readonly repository: string; readonly issueNumber: number };

/** The routing one deployment answers the scenario routes with. */
export type ScenarioRouting = {
	readonly runs: ScenarioRuns;
	readonly devEnabled: boolean;
	/** The fixture the runs open on, or null when this deployment does not carry it. */
	readonly fixture: ScenarioFixture | null;
	/** Provisions the run's own visitor for one start: its VISITORS_DAY slot, and its fork where the App makes one. */
	readonly provision: (requester: VisitorRow) => Promise<DemoVisitorResult>;
	/** The deps one run uses, bound to the run's own visitor. */
	readonly depsFor: (runVisitor: VisitorRow, fixture: ScenarioFixture) => ScenarioDeps;
};

export type ScenarioReply = { readonly status: number; readonly body: unknown };

/** What a deployment composes the routes from. The server passes its ports; a test passes the same composition over fakes. */
export type ScenarioComposition = {
	readonly acquit: Acquit;
	readonly store: Pick<SqliteStore, "readJob" | "db">;
	readonly workspace: ScenarioWorkspace;
	readonly runs: ScenarioRuns;
	readonly now: () => Instant;
	readonly devEnabled: boolean;
	readonly fixture: ScenarioFixture | null;
	readonly provision: (requester: VisitorRow) => Promise<DemoVisitorResult>;
};

/** The routing a deployment answers the scenario routes with. A run's job funds with the test card, as the command route funds a visitor's own job. */
export function scenarioRoutingFor(composition: ScenarioComposition): ScenarioRouting {
	return {
		runs: composition.runs,
		devEnabled: composition.devEnabled,
		fixture: composition.fixture,
		provision: composition.provision,
		depsFor: (runVisitor, fixture) => ({ acquit: composition.acquit, store: composition.store, workspace: composition.workspace,
			runs: composition.runs, now: composition.now, devEnabled: composition.devEnabled,
			repository: runVisitor.repository ?? fixture.repository, issueNumber: fixture.issueNumber,
			onOpened: jobId => defaultJobFunding(composition.store.db, jobId, "card", composition.now()) }),
	};
}

/** The registry entry a key names, as the scenarios' fixture, or null when the deployment does not carry it. */
export function scenarioFixtureOf(fixtures: readonly FixtureContract[], key: string): ScenarioFixture | null {
	const fixture = fixtures.find(candidate => fixtureKey(candidate.repository, candidate.issue.number) === key);
	return fixture ? { repository: fixture.repository, issueNumber: fixture.issue.number } : null;
}

function refused(status: number, error: string, detail?: string): ScenarioReply {
	return { status, body: detail === undefined ? { error } : { error, detail } };
}

/** A start the core refused: the denial's own reason, or a cap, which answers 429 as the demo route's caps do. */
function coreRefusalStatus(code: string): number {
	if (code === "DEV_DISABLED") return 403;
	if (code === "SCENARIO_OPEN_FAILED") return 502;
	if (code.startsWith("CAP_")) return 429;
	return 409;
}

async function startReply(routing: ScenarioRouting, requester: VisitorRow, name: string): Promise<ScenarioReply> {
	if (!isScenarioName(name)) return refused(404, "UNKNOWN_SCENARIO");
	if (scenarioNeedsDev(name) && !routing.devEnabled) return refused(403, "DEV_DISABLED", "Set ACQUIT_DEV=1 when starting the API.");
	const fixture = routing.fixture;
	if (fixture === null) return refused(503, "SCENARIO_FIXTURE_MISSING", "The deployment does not carry the fixture the judge scenarios open on.");
	// The place is reserved before anything is provisioned or opened, so a refused start costs no visitor and no job.
	const admitted = routing.runs.admit(requester.id);
	if (admitted.kind === "REFUSED") return refused(admitted.code === "SCENARIO_RUNNING_LIMIT" ? 429 : 503, admitted.code);
	let provisioned: DemoVisitorResult;
	try {
		provisioned = await routing.provision(requester);
	} catch (error) {
		admitted.slot.release();
		throw error;
	}
	if (provisioned.kind === "CAPPED") { admitted.slot.release(); return refused(429, provisioned.reason); }
	if (provisioned.kind === "NOT_CONFIGURED") {
		admitted.slot.release();
		return refused(503, "DEMO_NOT_CONFIGURED", "Set OPERATOR_DEVON_MERCHANT_ID to the sandbox seller the demo pays through.");
	}
	if (provisioned.kind === "FAILED") { admitted.slot.release(); return refused(502, "DEMO_REPOSITORY_FAILED", provisioned.detail); }
	try {
		const started = await startScenario(routing.depsFor(provisioned.visitor, fixture), name, provisioned.visitor, requester.id, admitted.slot);
		return { status: 201, body: { scenarioId: started.run.id, jobId: started.run.jobId } };
	} catch (error) {
		if (error instanceof ScenarioRefused) return refused(coreRefusalStatus(error.code), error.code);
		throw error;
	}
}

/**
 * The two scenario routes, answered for one signed-in visitor. POST starts a run on a visitor of its own and
 * answers once its job exists; the rest of the chain goes on in the background. GET reads a run, and only the
 * visitor that started it can read it: another visitor's run answers the same 404 an unknown id does, so a run id
 * never confirms that someone else's run exists.
 */
export async function scenarioReply(routing: ScenarioRouting, visitor: VisitorRow, method: string, tail: string): Promise<ScenarioReply> {
	if (method === "POST") return startReply(routing, visitor, tail);
	if (method === "GET") {
		const run = routing.runs.get(tail);
		if (run === undefined || run.requesterId !== visitor.id) return refused(404, "NOT_FOUND");
		return { status: 200, body: run };
	}
	return refused(404, "NOT_FOUND");
}

/** The frozen suite the scripted trees were written for, at the path the score card judges. */
function frozenSuiteCompatible(workDir: string, frozenTestPath: string): boolean {
	if (frozenTestPath !== FROZEN_TEST_PATH) return false;
	const path = join(workDir, frozenTestPath);
	return existsSync(path) && frozenSuiteMatchesCorpus(readFileSync(path, "utf8"));
}

/**
 * The scripted agent's push. The House's clone at the job's own frozen commit, checked for the score card's
 * visible rows, then only the named entry's files written on top. The base is not written: the frozen package
 * and the frozen suite stay as the fixture froze them, except in the tamper entry, whose overwrite of the frozen
 * suite is the point. The House's finalize commits and pushes the tree, and the commit it returns is the one
 * the Submit names.
 */
export function scriptedWorkspace(ports: { readonly work: HouseWorkPort; readonly readJob: (id: JobId) => Promise<JobRow | null> }): ScenarioWorkspace {
	return {
		async push(jobId, tree) {
			const row = await ports.readJob(jobId);
			if (row === null) throw new Error("the job is missing");
			const definition = row.contract.definitionOfDone;
			if (definition === null) throw new Error("the job has no frozen definition");
			const entry = CORPUS.find(candidate => candidate.id === tree);
			if (entry === undefined) throw new Error(`no score card entry named ${tree}`);
			const target: HouseTarget = { id: jobId, title: row.title, repository: definition.issue.repository, frozenAt: definition.frozenAt,
				tenant: row.tenant ?? null };
			const { workDir } = await ports.work.prepare(target);
			try {
				if (!frozenSuiteCompatible(workDir, definition.frozenTestPath)) {
					throw new Error("SCENARIO_FIXTURE_INCOMPATIBLE: the frozen suite does not carry the score card's visible rows");
				}
				entry.write(workDir);
				const delivery = await ports.work.finalize(target, workDir);
				if (delivery === null) throw new Error("the scripted tree left nothing to submit");
				return delivery.commit;
			} finally {
				ports.work.remove(jobId);
			}
		},
	};
}
