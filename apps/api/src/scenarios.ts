// The scenario routes' server side. A signed-in visitor starts one of the five judge scenarios and reads
// its run. Each start provisions the run its own visitor, so one session can start all five, and each run
// keeps its own job, repository, and work repo. The run lives on the server, so a closed tab does not stop
// it. Its steps act through the core as the run visitor's own actors, and its scripted tree is written onto
// the job's frozen checkout, so the real judge judges what the scenario names.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Acquit, DemoVisitorResult } from "../../../packages/core/src/acquit.ts";
import { defaultJobFunding } from "../../../packages/core/src/funding.ts";
import { fixtureKey, matchFixture } from "../../../packages/core/src/fixtures.ts";
import type { FixtureContract } from "../../../packages/core/src/fixtures.ts";
import type { Instant, JobId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { FROZEN_TEST_PATH, scriptedTree } from "../../../packages/core/src/score-card-trees.ts";
import type { FrozenCase } from "../../../packages/core/src/score-card-trees.ts";
import { isScenarioName, ScenarioRefused, startScenario } from "../../../packages/core/src/scenarios.ts";
import type { ScenarioDeps, ScenarioRuns, ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import type { SqliteStore } from "../../../packages/core/src/store.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import type { HiddenCase } from "../../../packages/core/src/verifier.ts";
import type { HouseTarget, HouseWorkPort } from "../../../packages/house/src/runner.ts";
import { invoiceFixtureFrozenCases } from "../../../packages/verifier/frozen-cases.ts";

/** The fixture every judge scenario opens on: the repository and issue its registry entry names. */
export type ScenarioFixture = { readonly repository: string; readonly issueNumber: number };

/** The routing one deployment answers the scenario routes with. */
export type ScenarioRouting = {
	readonly runs: ScenarioRuns;
	/** The fixture the runs open on, or null when this deployment does not carry it. */
	readonly fixture: ScenarioFixture | null;
	/** The repository the App forks every run visitor from. The scenario fixture must be on this repository. */
	readonly forkSource: string;
	/** The fixture a job opened on a fork of `forkRepository` freezes, as the core's OpenJob resolves it. */
	readonly forkedFixture: (forkRepository: string, issueNumber: number) => ScenarioFixture | null;
	/** Provisions the run's own visitor for one start: its SCENARIOS_DAY and requester slots, and its fork where the App makes one. */
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
	readonly fixture: ScenarioFixture | null;
	/** The deployment's fixture registry, the one the core opens jobs against. */
	readonly fixtures: readonly FixtureContract[];
	/** The repository the App forks each run visitor from. */
	readonly forkSource: string;
	readonly provision: (requester: VisitorRow) => Promise<DemoVisitorResult>;
};

/** The routing a deployment answers the scenario routes with. A run's job funds with the test card, as the command route funds a visitor's own job. */
export function scenarioRoutingFor(composition: ScenarioComposition): ScenarioRouting {
	return {
		runs: composition.runs,
		fixture: composition.fixture,
		forkSource: composition.forkSource,
		forkedFixture: (forkRepository, issueNumber) => {
			const fixture = matchFixture(composition.fixtures, forkRepository, issueNumber, forkRepository, composition.forkSource);
			return fixture === null ? null : { repository: fixture.repository, issueNumber: fixture.issue.number };
		},
		provision: composition.provision,
		depsFor: (runVisitor, fixture) => ({ acquit: composition.acquit, store: composition.store, workspace: composition.workspace,
			runs: composition.runs, now: composition.now,
			repository: runVisitor.repository ?? fixture.repository, issueNumber: fixture.issueNumber,
			onOpened: jobId => defaultJobFunding(composition.store.db, jobId, "card", composition.now()) }),
	};
}

function sameFixture(a: ScenarioFixture | null, b: ScenarioFixture): boolean {
	return a !== null && a.repository === b.repository && a.issueNumber === b.issueNumber;
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
	if (code === "SCENARIO_OPEN_FAILED") return 502;
	if (code.startsWith("CAP_")) return 429;
	return 409;
}

async function startReply(routing: ScenarioRouting, requester: VisitorRow, name: string): Promise<ScenarioReply> {
	if (!isScenarioName(name)) return refused(404, "UNKNOWN_SCENARIO");
	const fixture = routing.fixture;
	if (fixture === null) return refused(503, "SCENARIO_FIXTURE_MISSING", "The deployment does not carry the fixture the judge scenarios open on.");
	// A visitor's fork is made from the forkSource alone, so a fixture on any other repository could never be the one a run opens.
	if (fixture.repository !== routing.forkSource) {
		return refused(503, "SCENARIO_FIXTURE_MISMATCH", "The scenario fixture is not on the repository the App forks visitors from.");
	}
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
	// A fork opens the job on the repository the App made, and the core resolves that fork to one registered fixture.
	// The run must open on the scenario's fixture, so a different resolution is refused before the open.
	const fork = provisioned.visitor.repository;
	if (fork !== null && !sameFixture(routing.forkedFixture(fork, fixture.issueNumber), fixture)) {
		admitted.slot.release();
		return refused(503, "SCENARIO_FIXTURE_MISMATCH", "A visitor's fork opens on another registered fixture than the scenario's.");
	}
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

const INCOMPATIBLE = "SCENARIO_FIXTURE_INCOMPATIBLE";

function incompatibleFixture(detail: string): ScenarioRefused {
	return new ScenarioRefused(INCOMPATIBLE, `the frozen suite cannot be scripted: ${detail}`);
}

/**
 * The frozen cases a checkout's suite carries, read by the verifier's own extractor, or a refusal. The suite must
 * import formatTotal from ../src/money, and the extractor must read a case with that target from it. The trees are
 * written from these cases, so the suite's rows need not be the score card's.
 */
function frozenCasesOf(workDir: string, frozenTestPath: string): readonly FrozenCase[] {
	if (frozenTestPath !== FROZEN_TEST_PATH) throw incompatibleFixture(`the suite is at ${frozenTestPath}, not ${FROZEN_TEST_PATH}`);
	const path = join(workDir, frozenTestPath);
	if (!existsSync(path)) throw incompatibleFixture("the checkout has no frozen suite");
	const suite = readFileSync(path, "utf8");
	if (!/import \{ formatTotal \} from ['"]\.\.\/src\/money['"]/.test(suite)) {
		throw incompatibleFixture("the suite does not import formatTotal from ../src/money");
	}
	let extracted: readonly HiddenCase[];
	try {
		extracted = invoiceFixtureFrozenCases(suite);
	} catch {
		throw incompatibleFixture("the verifier's extractor reads no frozen cases from the suite");
	}
	if (!extracted.some(frozen => frozen.target.export === "formatTotal")) {
		throw incompatibleFixture("the extractor reads no case of formatTotal");
	}
	const cases: FrozenCase[] = [];
	for (const frozen of extracted) {
		if (typeof frozen.expected !== "string") throw incompatibleFixture("a frozen case does not expect a string");
		cases.push({ target: frozen.target, args: frozen.args, expected: frozen.expected });
	}
	return cases;
}

/**
 * The scripted agent's push. The House's clone at the job's own frozen commit, checked by frozenCasesOf, then only
 * the named tree's files written on top. The base is not written: the frozen package and the frozen suite stay as
 * the fixture froze them, except in the tamper tree, whose overwrite of the frozen suite is the point. The House's
 * finalize commits and pushes the tree, and the commit it returns is the one the Submit names.
 */
export function scriptedWorkspace(ports: { readonly work: HouseWorkPort; readonly readJob: (id: JobId) => Promise<JobRow | null> }): ScenarioWorkspace {
	return {
		async push(jobId, tree) {
			const row = await ports.readJob(jobId);
			if (row === null) throw new Error("the job is missing");
			const definition = row.contract.definitionOfDone;
			if (definition === null) throw new Error("the job has no frozen definition");
			const target: HouseTarget = { id: jobId, title: row.title, repository: definition.issue.repository, frozenAt: definition.frozenAt,
				tenant: row.tenant ?? null };
			const { workDir } = await ports.work.prepare(target);
			try {
				scriptedTree(tree, frozenCasesOf(workDir, definition.frozenTestPath))(workDir);
				const delivery = await ports.work.finalize(target, workDir);
				if (delivery === null) throw new Error("the scripted tree left nothing to submit");
				return delivery.commit;
			} finally {
				ports.work.remove(jobId);
			}
		},
	};
}
