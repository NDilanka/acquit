// The scenario routes' server side. A signed-in visitor starts one of the five judge scenarios and reads
// its run. The run lives on the server, so a closed tab does not stop it; its steps act through the core as
// the visitor's own actors; and the scripted agent's tree is committed to the job's own work repo through
// the House's git port, with the score card's files, so the real judge judges what the scenario names.

import type { JobId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { CORPUS, writeBase } from "../../../packages/core/src/score-card-trees.ts";
import { isScenarioName, ScenarioRefused, startScenario } from "../../../packages/core/src/scenarios.ts";
import type { ScenarioDeps, ScenarioRuns, ScenarioWorkspace } from "../../../packages/core/src/scenarios.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import type { HouseTarget, HouseWorkPort } from "../../../packages/house/src/runner.ts";

export type ScenarioRouting = {
	readonly runs: ScenarioRuns;
	/** The deps one visitor's run uses, or null when the deployment has no fixture for that visitor. */
	readonly depsFor: (visitor: VisitorRow) => ScenarioDeps | null;
};

export type ScenarioReply = { readonly status: number; readonly body: unknown };

/**
 * The two scenario routes, answered for one signed-in visitor. POST starts a run and answers once its job
 * exists; the rest of the chain goes on in the background. GET reads a run, and only the visitor that
 * started it can read it: another visitor's run answers the same 404 an unknown id does, so a run id never
 * confirms that someone else's run exists.
 */
export async function scenarioReply(routing: ScenarioRouting, visitor: VisitorRow, method: string, tail: string): Promise<ScenarioReply> {
	if (method === "POST") {
		if (!isScenarioName(tail)) return { status: 404, body: { error: "UNKNOWN_SCENARIO" } };
		const deps = routing.depsFor(visitor);
		if (deps === null) return { status: 503, body: { error: "NO_FIXTURE", detail: "The deployment has no fixture for this visitor." } };
		try {
			const started = await startScenario(deps, tail, visitor);
			if (started.run.jobId === "") return { status: 502, body: { error: "SCENARIO_OPEN_FAILED", scenarioId: started.run.id } };
			return { status: 201, body: { scenarioId: started.run.id, jobId: started.run.jobId } };
		} catch (error) {
			if (error instanceof ScenarioRefused) return { status: 403, body: { error: error.code, detail: "Set ACQUIT_DEV=1 when starting the API." } };
			throw error;
		}
	}
	if (method === "GET") {
		const run = routing.runs.get(tail);
		if (run === undefined || run.visitorId !== visitor.id) return { status: 404, body: { error: "NOT_FOUND" } };
		return { status: 200, body: run };
	}
	return { status: 404, body: { error: "NOT_FOUND" } };
}

/**
 * The scripted agent's push. The House's clone at the job's frozen commit, the score card's base written
 * over it, then the named entry written on top: the same tree the score card judges. The House's finalize
 * commits and pushes it, and the commit it returns is the one the Submit names.
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
				writeBase(workDir);
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
