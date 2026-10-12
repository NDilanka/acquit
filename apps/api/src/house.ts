// The deployment's House: the API's own delivery loop. One scan per tick picks the held House jobs
// and walks each through the delivery series in this process -- the same Submit edge every operator
// uses, the same sandbox path the CLI runs, the model provider switch naming droid by default and
// the OpenRouter path when selected. The loop is bounded from every side: one delivery at a time,
// two calls per job ever, ten submits per series, and a scan that stops at the first in-flight
// delivery.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerCli, type GitRun } from "../../../packages/acquit-cli/src/run.ts";
import type { Actor, CommandOutcome, UserCommand } from "../../../packages/core/src/acquit.ts";
import type { JobId, CommitSha } from "../../../packages/core/src/ids.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import {
	gitWorkPort, houseActorFor, houseFactsOf, houseMode, houseRunPort, isDeliverableHouseJob, runHouseDelivery,
	stateStore, type HouseDeliveryDeps, type HouseDeliveryState, type HouseRunPort, type HouseTarget, type HouseWorkPort,
} from "../../../packages/house/src/runner.ts";

export type HousePorts = {
	/** The stored job rows, all of them; the scan applies the domain predicate itself. */
	readonly jobs: () => readonly JobRow[];
	/** Mints the scoped token one push uses, and answers with the work repo it scoped to. */
	readonly mint: (job: HouseTarget) => Promise<{ readonly repository: string; readonly token: string }>;
	/** The Submit edge, as the API's own request path runs it: one call, one outcome, the actor the
	 * House submits as built from the job's own tenant. */
	readonly execute: (actor: Actor, command: UserCommand) => Promise<CommandOutcome>;
	/** Persists one delivery's diff for the job's timeline, before the Submit edge runs. */
	readonly recordDiff: (jobId: JobId, commit: CommitSha, files: readonly { readonly path: string; readonly added: number; readonly binary: boolean }[], patch: string) => Promise<void>;
	/** Where the House keeps its state files and its checkouts, e.g. beside the database. */
	readonly stateDir: string;
	readonly image?: string;
	readonly proxyImage?: string;
	readonly git?: GitRun;
	readonly env?: NodeJS.ProcessEnv;
	/** Overrides for tests; the real wiring runs the provider switch's port in the sandbox. */
	readonly run?: HouseRunPort;
	readonly work?: HouseWorkPort;
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

	// The pause latch is durable on purpose: a rate or usage limit stops dispatching until the
	// operator removes the file, and a service restart must not resume an exhausted provider.
	const pausedPath = join(ports.stateDir, "house", "paused.json");
	let pauseAnnounced = false;
	function announcePause(): void {
		if (pauseAnnounced) return;
		log(`House deliveries paused after a provider rate/usage limit; remove ${pausedPath} to resume`);
		pauseAnnounced = true;
	}

	async function kick(): Promise<void> {
		if (running) return;
		running = true;
		try {
			if (existsSync(pausedPath)) { announcePause(); return; }
			for (const job of await deliverableTargets()) {
				const outcome = await runHouseDelivery(deps, job);
				if (outcome === "RATE_LIMITED") {
					writeFileSync(pausedPath, `${JSON.stringify({ reason: "RATE_LIMITED", at: new Date().toISOString(), jobId: job.id }, null, "\t")}\n`, { mode: 0o600 });
					announcePause();
					return;
				}
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
			// The tenant comes from the stored row, the same one the House bid with -- never from a
			// state file: the submit may act in exactly the world the job belongs to.
			targets.push({ id: row.id, title: row.title, repository: definition.issue.repository, frozenAt: definition.frozenAt, tenant: row.tenant ?? null });
		}
		return targets;
	}

	function worthStarting(state: HouseDeliveryState): boolean {
		if (state.submittedCommit !== null) return state.submitAttempts < 10;
		return state.calls < 2 && state.prepareFailures < 20;
	}

	const deps: HouseDeliveryDeps = {
		mode,
		run: ports.run ?? houseRunPort({
			docker: dockerCli(),
			image: ports.image ?? (env.ACQUIT_RUNNER_IMAGE?.trim() || "acquit/runner-node20"),
			proxyImage: ports.proxyImage ?? (env.ACQUIT_RUNNER_PROXY_IMAGE?.trim() || env.ACQUIT_RUNNER_IMAGE?.trim() || "acquit/runner-node20"),
			env,
		}),
		work: ports.work ?? gitWorkPort({
			stateRoot: join(ports.stateDir, "house", "checkouts"),
			workRoot: join(ports.stateDir, "house", "work"),
			mint: ports.mint,
			git: ports.git,
			env,
		}),
		readState: store.readState,
		writeState: store.writeState,
		submit: async (job, commit, delivery) => {
			// The diff lands before the edge: a timeline that shows the model's own diff must show it
			// even when the submit itself needs the next tick's retry.
			if (delivery) await ports.recordDiff(job.id, delivery.commit, delivery.files, delivery.patch);
			// A denial still resolved -- the domain heard the submit -- so it resolves here too and
			// the series' attempt counter stays the one bound on the loop.
			const outcome = await ports.execute(houseActorFor(job.tenant), { type: "Submit", jobId: job.id, sourceCommit: commit });
			if (outcome.kind === "DENIED") log(`house: ${job.id} submit denied: ${outcome.reason}`);
		},
		log,
	};
	return { kick };
}
