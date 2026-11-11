// The laser push: the delivery file reaches the job's work repo as one commit on the frozen commit, pushed with the
// one credential the caller gave. A git that leaves the tree unchanged pushes nothing. Git is a fake, as the House's
// own port tests are, so no network or credential is used.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LASER_CUT_WORKFLOW } from "../../../packages/core/src/physical.ts";
import type { GitResult, GitRun } from "../../../packages/acquit-cli/src/run.ts";
import { pushLaserDelivery } from "../src/laser-push.ts";

const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n";
const SUBMITTED = "b4c7fbe30a5f478e2982f862c627df0e943982f5";
const FORK = "maya-client/invoice-app-visitor";
const WORK = "acquit-work/invoice-app-visitor-job_laser";

const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });

/** A fake git for one laser push. `dirty` says whether the checkout has changes the push would commit. The record keeps
 * the pushed arguments and the file content the commit carried, read from the work tree at commit time. */
function fakeGit(record: { pushes: string[]; committed: string | null }, dirty: boolean): GitRun {
	let workTree = "";
	let committed = false;
	return (args) => {
		if (args.includes("clone")) {
			const gitDir = args[args.indexOf("--separate-git-dir") + 1];
			workTree = args.at(-1) as string;
			mkdirSync(gitDir, { recursive: true, mode: 0o700 });
			mkdirSync(workTree, { recursive: true, mode: 0o700 });
			writeFileSync(join(workTree, ".git"), `gitdir: ${gitDir}\n`, { mode: 0o644 });
			return ok();
		}
		if (args.includes("push")) record.pushes.push(args.join(" "));
		if (args.includes("commit")) {
			committed = true;
			record.committed = readFileSync(join(workTree, LASER_CUT_WORKFLOW.deliveryPath), "utf8");
		}
		if (args.includes("rev-parse")) return ok(`${committed ? SUBMITTED : LASER_CUT_WORKFLOW.frozenAt}\n`);
		if (args.includes("--porcelain")) return ok(dirty && !committed ? " M delivery/part.svg\n" : "");
		if (args.includes("--numstat")) return ok("1\t0\0delivery/part.svg\0");
		return ok();
	};
}

test("a laser delivery is committed at its path on the frozen commit and pushed with the job's one credential", async () => {
	const record = { pushes: [] as string[], committed: null as string | null };
	const delivery = await pushLaserDelivery({ jobId: "job_LASER1", repository: FORK,
		credential: { repository: WORK, token: "GHT-TEST-TOKEN" }, svg: SVG, git: fakeGit(record, true) });
	assert.equal(delivery.commit, SUBMITTED, "the submission commit is the one the push carried");
	assert.equal(record.committed, SVG, "the commit carries the delivery file as written");
	assert.equal(record.pushes.length, 1, "exactly one push");
	assert.match(record.pushes[0] ?? "", /https:\/\/github\.com\/acquit-work\/invoice-app-visitor-job_laser\.git/, "the push goes to the work repo the credential names");
	assert.doesNotMatch(record.pushes[0] ?? "", /GHT-TEST-TOKEN/, "the token never appears in the push arguments");
});

test("a delivery that leaves the work repo unchanged is refused and pushes nothing", async () => {
	const record = { pushes: [] as string[], committed: null as string | null };
	await assert.rejects(pushLaserDelivery({ jobId: "job_LASER2", repository: FORK,
		credential: { repository: WORK, token: "GHT-TEST-TOKEN" }, svg: SVG, git: fakeGit(record, false) }),
	/nothing was pushed/);
	assert.equal(record.pushes.length, 0, "no push when the tree is unchanged");
});
