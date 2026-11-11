// The laser delivery push: writes one delivery file, commits it on the frozen commit and pushes that commit to the
// job's work repo. It runs the House's own git port (clone, commit, push, cleanup), so a physical push takes the same
// path a code job's push takes. The credential is the caller's: the operator's work-repo token for this job, so this
// module holds no App key.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JobId } from "../../../packages/core/src/ids.ts";
import { LASER_CUT_WORKFLOW } from "../../../packages/core/src/physical.ts";
import { gitCli, type GitRun } from "../../../packages/acquit-cli/src/run.ts";
import { gitWorkPort } from "../../../packages/house/src/runner.ts";
import type { HouseDelivery, HouseTarget } from "../../../packages/house/src/runner.ts";

export type LaserPushInput = {
	/** The job's id, as the API names it. */
	readonly jobId: string;
	/** The repository the job's contract froze: the visitor's own fork. */
	readonly repository: string;
	/** The work repo and the one token this push uses, as the work-repo-token answer gives them. */
	readonly credential: { readonly repository: string; readonly token: string };
	/** The complete delivery file, written at the delivery path the physical workflow names. */
	readonly svg: string;
	/** The git the port runs. Defaults to the host git. */
	readonly git?: GitRun;
};

/** Pushes one delivery and returns the submission commit with its own diff, ready for a Submit. */
export async function pushLaserDelivery(input: LaserPushInput): Promise<HouseDelivery> {
	const root = mkdtempSync(join(tmpdir(), "acquit-laser-push-"));
	const target: HouseTarget = { id: input.jobId as JobId, title: LASER_CUT_WORKFLOW.title, repository: input.repository,
		frozenAt: LASER_CUT_WORKFLOW.frozenAt, tenant: null };
	const port = gitWorkPort({ stateRoot: join(root, "state"), workRoot: join(root, "work"), mint: async () => input.credential,
		env: process.env, git: input.git ?? gitCli() });
	try {
		const prepared = await port.prepare(target);
		const file = join(prepared.workDir, LASER_CUT_WORKFLOW.deliveryPath);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, input.svg);
		const delivery = await port.finalize(target, prepared.workDir);
		if (delivery === null) throw new Error("the delivery left the work repo unchanged, so nothing was pushed");
		return delivery;
	} finally {
		port.remove(target.id);
		rmSync(root, { recursive: true, force: true });
	}
}
