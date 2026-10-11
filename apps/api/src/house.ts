// The deployment's House: the API's own delivery loop. One scan per tick picks the held House jobs
// and walks each through the delivery series in this process -- the same Submit edge every operator
// uses, the same sandbox path the CLI runs, the model provider switch naming droid by default and
// the OpenRouter path when selected. The loop is bounded from every side: one delivery at a time,
// two calls per job ever, ten submits per series, and a scan that stops at the first in-flight
// delivery.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dockerCli, type GitRun } from "../../../packages/acquit-cli/src/run.ts";
import type { CommandOutcome, UserCommand } from "../../../packages/core/src/acquit.ts";
import type { JobId, CommitSha, OperatorId } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import {
	gitWorkPort, houseFactsOf, houseMode, HOUSE_OPERATOR_ID, houseRunPort, isDeliverableHouseJob, runHouseDelivery,
	stateStore, type HouseDeliveryDeps, type HouseDeliveryState, type HouseTarget,
} from "../../../packages/house/src/runner.ts";

export type HousePorts = {
	/** The stored job rows, all of them; the scan applies the domain predicate itself. */
	readonly jobs: () => readonly JobRow[];
	/** Mints the scoped token one push uses, and answers with the work repo it scoped to. */
	readonly mint: (job: HouseTarget) => Promise<{ readonly repository: string; readonly token: string }>;
	/** The Submit edge, as the API's own request path runs it: one call, one outcome. */
	readonly execute: (command: UserCommand) => Promise<CommandOutcome>;
	/** Persists one delivery's diff for the job's timeline, before the Submit edge runs. */
	readonly recordDiff: (jobId: JobId, commit: CommitSha, files: readonly { readonly path: string; readonly added: number; readonly binary: boolean }[], patch: string) => Promise<void>;
	/** Where the House keeps its state files and its checkouts, e.g. beside the database. */
	readonly stateDir: string;
	readonly image?: string;
	readonly proxyImage?: string;
	readonly git?: GitRun;
	readonly env?: NodeJS.ProcessEnv;
};

/** The loop. Kick it from the tick; it returns at once when a delivery is already in flight. */
export function createHouseDelivery(ports: HousePorts): { readonly kick: () => Promise<void> } {
	const env = ports.env ?? process.env;
	const store = stateStore(join(ports.stateDir, "house"));
	mkdirSync(join(ports.stateDir, "house"), { recursive: true, mode: 0o700 });
	const mode = houseMode(env);
	const log = (line: string) => console.log(line);

	// At most one delivery in flight: the House runs one job at a time, and the state files are the
	// only shared thing between ticks.
	let running = false;

	async function kick(): Promise<void> {
		if (running) return;
		running = true;
		try {
			for (const job of await deliverableTargets()) {
				await runHouseDelivery(deps, job);
			}
		} catch (error) {
			log(`house: scan failed; the next tick retries (${error instanceof Error ? error.message.slice(0, 200) : "unknown"})`);
		} finally {
			running = false;
		}
	}

	async function deliverableTargets(): Promise<readonly HouseTarget[]> {
		const targets: HouseTarget[] = [];
		for (const row of ports.jobs()) {
			if (!isDeliverableHouseJob(houseFactsOf(row))) continue;
			const definition = row.contract.definitionOfDone;
			if (definition === null) continue;
			const state = await store.readState(row.id);
			if (!worthStarting(state)) continue;
			targets.push({ id: row.id, title: row.title, repository: definition.issue.repository, frozenAt: definition.frozenAt });
		}
		return targets;
	}

	function worthStarting(state: HouseDeliveryState): boolean {
		if (state.submittedCommit !== null) return state.submitAttempts < 10;
		return state.calls < 2 && state.prepareFailures < 20;
	}

	const deps: HouseDeliveryDeps = {
		mode,
		run: houseRunPort({
			docker: dockerCli(),
			image: ports.image ?? (env.ACQUIT_RUNNER_IMAGE?.trim() || "acquit/runner-node20"),
			proxyImage: ports.proxyImage ?? (env.ACQUIT_RUNNER_PROXY_IMAGE?.trim() || env.ACQUIT_RUNNER_IMAGE?.trim() || "acquit/runner-node20"),
			env,
		}),
		work: gitWorkPort({
			stateRoot: join(ports.stateDir, "house", "checkouts"),
			workRoot: join(ports.stateDir, "house", "work"),
			mint: ports.mint,
			git: ports.git,
			env,
		}),
		readState: store.readState,
		writeState: store.writeState,
		submit: async (jobId: JobId, commit: CommitSha, delivery) => {
			// The diff lands before the edge: a timeline that shows the model's own diff must show it
			// even when the submit itself needs the next tick's retry.
			if (delivery) await ports.recordDiff(jobId, delivery.commit, delivery.files, delivery.patch);
			// A denial still resolved -- the domain heard the submit -- so it resolves here too and
			// the series' attempt counter stays the one bound on the loop.
			const outcome = await ports.execute({ type: "Submit", jobId, sourceCommit: commit });
			if (outcome.kind === "DENIED") log(`house: ${jobId} submit denied: ${outcome.reason}`);
		},
		log,
	};
	return { kick };
}

/** The actor the House submits as: the deployment's own seeded operator, never a client's. */
export function houseActor(): { role: "OPERATOR"; operatorId: OperatorId; tenant: null } {
	return { role: "OPERATOR", operatorId: HOUSE_OPERATOR_ID as OperatorId, tenant: null };
}
