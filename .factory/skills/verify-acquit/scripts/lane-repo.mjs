// Prepares one lane's work directory from the invoice-app fixture:
//   node .factory/skills/verify-acquit/scripts/lane-repo.mjs <lane> <branch> [--template <dir>] [--force]
// It clones the template (so the lane can never disturb the fixture), checks out the branch, and
// prints the exact submit command for that lane's API port.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { laneSlot } from "../../../../packages/ctl/src/state.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
	template: { type: "string" }, force: { type: "boolean", default: false }, jobs: { type: "string" },
} });
const [laneRaw, branch] = positionals;
assert(laneRaw !== undefined && branch !== undefined, "Usage: lane-repo.mjs <lane> <branch> [--template <dir>] [--force]");
const lane = Number(laneRaw);
assert(Number.isSafeInteger(lane) && lane >= 0, "Lane must be a whole number.");
const template = resolve(values.template ?? process.env.ACQUIT_VERIFIER_FIXTURE ?? resolve(root, "../../acquit/scratch/verifier/invoice-app"));
assert(existsSync(resolve(template, ".git")), `No invoice-app template at ${template}. Set --template or ACQUIT_VERIFIER_FIXTURE.`);
const branches = spawnSync("git", ["-C", template, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" }).stdout.trim().split("\n");
assert(branches.includes(branch), `Unknown branch ${branch}. The template has: ${branches.join(", ")}`);
const repo = resolve(root, `../../acquit/scratch/verifier/invoice-app-lane-${lane}`);
if (existsSync(repo)) {
	assert(values.force, `${repo} exists. Pass --force to recreate it.`);
	await rm(repo, { recursive: true, force: true });
}
const cloned = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", template, repo], { encoding: "utf8" });
assert.equal(cloned.status, 0, `Clone failed: ${cloned.stderr?.trim()}`);
const checked = spawnSync("git", ["-C", repo, "checkout", "--quiet", branch], { encoding: "utf8" });
assert.equal(checked.status, 0, `Checkout failed: ${checked.stderr?.trim()}`);
const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const slot = laneSlot(lane);
console.log(JSON.stringify({ lane, branch, repo, head, apiPort: slot.apiPort, webPort: slot.webPort,
	cli: `node packages/acquit-cli/src/main.ts submit ${values.jobs ?? "JOB_ID"} --dir ${repo} --api http://127.0.0.1:${slot.apiPort}` }));
