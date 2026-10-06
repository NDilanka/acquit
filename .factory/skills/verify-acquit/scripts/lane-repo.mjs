// Prepares one lane's work directory from the invoice-app fixture:
//   node .factory/skills/verify-acquit/scripts/lane-repo.mjs <lane> <branch> [--template <dir>] [--force] [--jobs <jobId>]
// It clones the template (so the lane can never disturb the fixture), checks out the branch, and
// prints the exact submit command for that lane's API port. With --jobs the command also carries
// --remote <the job's work repo>, so the lane's HEAD is pushed to GitHub before the run starts.
//
// The client repo a lane's job names is the deployment's client repository, `ACQUIT_CLIENT_REPOSITORY`
// (default `maya-client/invoice-app`). It must exist on GitHub and carry the frozen commit as its
// default branch. --owner <account> --create makes that repo (private, main = the template's main)
// when `gh` is authenticated, and reports whether the App installation can see it. The printed
// clientRepo is what the contract must name.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { laneSlot } from "../../../../packages/ctl/src/state.ts";
import { createGitHubApp, workRepoName } from "../../../../packages/core/src/github.ts";
import { clientRepositoryEnv, githubAppEnv } from "../../../../packages/verifier/config.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
	template: { type: "string" }, force: { type: "boolean", default: false }, jobs: { type: "string" },
	owner: { type: "string" }, repo: { type: "string" }, create: { type: "boolean", default: false },
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
const frozen = spawnSync("git", ["-C", template, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim();
const owner = values.owner ?? process.env.ACQUIT_LANE_REPO_OWNER ?? null;
const contractRepo = clientRepositoryEnv();
const clientRepo = owner === null ? contractRepo : `${owner}/${values.repo ?? `invoice-app-lane-${lane}`}`;
const creation = values.create ? await ensureClientRepo(clientRepo, frozen, template) : null;
// The job's work repo is a fork of the contract repository under the App's organization, named after
// the job. With --jobs the printed command pushes the lane's HEAD straight to it.
const organization = githubAppEnv().organization ?? "acquit-forks";
const workRemote = values.jobs === undefined ? null : `https://github.com/${organization}/${workRepoName(contractRepo, values.jobs)}.git`;
const slot = laneSlot(lane);
console.log(JSON.stringify({ lane, branch, repo, head, frozen, apiPort: slot.apiPort, webPort: slot.webPort, verifierPort: slot.verifierPort,
	clientRepo, creation, workRemote,
	cli: `node packages/acquit-cli/src/main.ts submit ${values.jobs ?? "JOB_ID"} --dir ${repo} --remote ${workRemote ?? "<work repo URL>"} --api http://127.0.0.1:${slot.apiPort}` }));

/** Creates the lane's client repo with the frozen commit as main, and reports whether the App can see it. */
async function ensureClientRepo(fullName, frozenCommit, templateDir) {
	assert(fullName !== null, "--create needs --owner <account> (or ACQUIT_LANE_REPO_OWNER).");
	const [account, name] = fullName.split("/");
	const gh = (args) => spawnSync("gh", args, { encoding: "utf8" });
	assert.equal(gh(["auth", "status"]).status, 0, "gh is not authenticated. Run gh auth login, or create the repo yourself and push main to it.");
	const seen = gh(["api", `repos/${fullName}`, "--jq", ".private"]);
	if (seen.status !== 0) {
		const created = gh(["repo", "create", fullName, "--private", "--description", "Acquit lane client fixture"]);
		assert.equal(created.status, 0, `Could not create ${fullName}: ${created.stderr?.trim()}`);
	}
	const pushed = await pushMain(templateDir, fullName, frozenCommit);
	// A selected installation does not see a repo created after it was installed. The App is the
	// verifier's own client, so ask it rather than assuming.
	let access = "unknown";
	try {
		const github = githubAppEnv();
		const token = await createGitHubApp(github).installationToken(account);
		const answer = await fetch(`${github.apiBase ?? "https://api.github.com"}/repos/${fullName}`,
			{ headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "acquit-lane-repo" } });
		access = answer.ok ? "visible" : `not visible (HTTP ${answer.status}): add ${fullName} to the App installation`;
	} catch (error) { access = `unverified: ${error instanceof Error ? error.message : String(error)}`; }
	return { created: seen.status !== 0, main: pushed, appAccess: access };
}

/** Pushes the frozen commit as main with the App token in the environment's git config, never in a URL or argv. */
async function pushMain(templateDir, fullName, frozenCommit) {
	const token = await createGitHubApp(githubAppEnv()).installationToken(fullName.split("/")[0]);
	// git ignores `http.<url>.extraHeader` from a global config file, and GitHub's git endpoint takes
	// the installation token as a Basic user, not as a bearer token.
	const pushed = spawnSync("git", ["-C", templateDir, "-c", "credential.helper=", "push", "--quiet",
		`https://github.com/${fullName}.git`, `${frozenCommit}:refs/heads/main`],
		{ encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
			GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
	assert.equal(pushed.status, 0, `Could not push main to ${fullName}: ${pushed.stderr?.trim()}`);
	return frozenCommit;
}
