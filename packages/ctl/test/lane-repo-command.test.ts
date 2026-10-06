// The lane command the verify-acquit skill prints must work on a deployment that sets
// ACQUIT_CLIENT_REPOSITORY: the job's contract names that repository, and submit must push the
// lane's HEAD to the job's work repository before it starts a run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = resolve(root, ".factory/skills/verify-acquit/scripts/lane-repo.mjs");

test("the printed lane command names the deployment's repository and the job's work repo", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-lane-repo-"));
	const template = join(dir, "template");
	const laneDir = resolve(root, "../../acquit/scratch/verifier/invoice-app-lane-99");
	try {
		await mkdir(template, { recursive: true });
		const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8", cwd: template });
		assert.equal(git(["init", "-q", "-b", "main"]).status, 0);
		await writeFile(join(template, "README.md"), "fixture\n");
		assert.equal(git(["add", "."]).status, 0);
		assert.equal(git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "fixture"]).status, 0);
		const run = spawnSync(process.execPath, [script, "99", "main", "--template", template, "--jobs", "job_7Q2K"],
			{ encoding: "utf8", cwd: root, env: { ...process.env, ACQUIT_CLIENT_REPOSITORY: "NDilanka/invoice-app", ACQUIT_GITHUB_APP_ORG: "acquit-forks" } });
		assert.equal(run.status, 0, run.stderr);
		const printed = JSON.parse(run.stdout) as { clientRepo: string; cli: string };
		assert.equal(printed.clientRepo, "NDilanka/invoice-app");
		assert.match(printed.cli, /--remote https:\/\/github\.com\/acquit-forks\/invoice-app-7Q2K\.git/);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		await rm(laneDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
