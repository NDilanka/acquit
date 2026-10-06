// The lane command the verify-acquit skill prints must work on a deployment that sets
// ACQUIT_CLIENT_REPOSITORY: the job's contract names that repository, and submit must push the
// lane's HEAD to the job's work repository before it starts a run.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = resolve(root, ".factory/skills/verify-acquit/scripts/lane-repo.mjs");
const CANARY = "acquit-lane-quote-canary";
const CANARY_TOKEN = "ghs_" + "C".repeat(36);
const HOSTILE_TMPDIR = `/tmp/acquit-lane-quote';touch ${CANARY};: 'q`;

test("the printed lane command names the deployment's repository and the job's work repo", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-lane-repo-"));
	const template = join(dir, "template");
	const laneDirs = [98, 99].map(lane => resolve(root, `../../acquit/scratch/verifier/invoice-app-lane-${lane}`));
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
		// --owner changes the client repo the contract names, so the work repo is named from that repo.
		const owned = spawnSync(process.execPath, [script, "98", "main", "--template", template, "--jobs", "job_7Q2K", "--owner", "probe-lanes"],
			{ encoding: "utf8", cwd: root, env: { ...process.env, ACQUIT_CLIENT_REPOSITORY: "NDilanka/invoice-app", ACQUIT_GITHUB_APP_ORG: "acquit-forks" } });
		assert.equal(owned.status, 0, owned.stderr);
		const ownedPrinted = JSON.parse(owned.stdout) as { clientRepo: string; cli: string };
		assert.equal(ownedPrinted.clientRepo, "probe-lanes/invoice-app-lane-98");
		assert.match(ownedPrinted.cli, /--remote https:\/\/github\.com\/acquit-forks\/invoice-app-lane-98-7Q2K\.git/);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		for (const laneDir of laneDirs) await rm(laneDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("the askpass reads its token file from the environment, and every printed path survives a hostile TMPDIR", async () => {
	const stub = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if ((req.url ?? "").startsWith("/app/installations?")) { res.writeHead(200); res.end(JSON.stringify([{ id: 42, account: { login: "acquit-forks" } }])); return; }
		if (req.url === "/app/installations/42/access_tokens" && req.method === "POST") {
			res.writeHead(201); res.end(JSON.stringify({ token: CANARY_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() })); return;
		}
		res.writeHead(404); res.end("{}");
	});
	await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", () => resolve()));
	const stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const lane = 97;
	const laneDir = resolve(root, `../../acquit/scratch/verifier/invoice-app-lane-${lane}`);
	const dir = await mkdtemp(join(tmpdir(), "acquit-lane-quote-"));
	const template = join(dir, "template");
	const cwd = join(dir, "cwd");
	try {
		await mkdir(cwd, { recursive: true });
		await mkdir(HOSTILE_TMPDIR, { recursive: true });
		await mkdir(template, { recursive: true });
		const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8", cwd: template });
		assert.equal(git(["init", "-q", "-b", "main"]).status, 0);
		await writeFile(join(template, "README.md"), "fixture\n");
		assert.equal(git(["add", "."]).status, 0);
		assert.equal(git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "fixture"]).status, 0);
		const printed = await new Promise<{ repo: string; cli: string; credential: { askpass: string; tokenFile: string } }>((resolve, reject) => {
			const child = spawn(process.execPath, [script, String(lane), "main", "--template", template, "--jobs", "job_7Q2K", "--askpass"],
				{ cwd: root, env: { ...process.env, ACQUIT_GITHUB_APP_ID: "1", ACQUIT_GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
					ACQUIT_GITHUB_APP_ORG: "acquit-forks", ACQUIT_GITHUB_API_BASE: stubBase, ACQUIT_CLIENT_REPOSITORY: "NDilanka/invoice-app", TMPDIR: HOSTILE_TMPDIR } });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", chunk => { stdout += chunk; });
			child.stderr.on("data", chunk => { stderr += chunk; });
			child.on("close", status => status === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`lane-repo exited ${status}: ${stderr}`)));
		});
		const answer = spawnSync("sh", [printed.credential.askpass, "Password for 'https://x-access-token@github.com': "],
			{ encoding: "utf8", cwd, env: { PATH: process.env.PATH ?? "", ACQUIT_LANE_ASKPASS_TOKEN_FILE: printed.credential.tokenFile } });
		assert.equal(answer.stdout.trim(), CANARY_TOKEN);
		// The printed command is runnable shell: a shim on PATH records the environment and argv it was handed.
		const bin = join(dir, "bin");
		const record = join(dir, "record.txt");
		await mkdir(bin);
		await writeFile(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$ACQUIT_LANE_ASKPASS_TOKEN_FILE" "$GIT_ASKPASS" "$@" > ${record}\n`, { mode: 0o700 });
		const ran = spawnSync("sh", ["-c", printed.cli], { encoding: "utf8", cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: HOSTILE_TMPDIR } });
		assert.equal(ran.status, 0, ran.stderr);
		const lines = readFileSync(record, "utf8").trimEnd().split("\n");
		assert.deepEqual(lines.slice(0, 2), [printed.credential.tokenFile, printed.credential.askpass]);
		assert.deepEqual(lines.slice(2, 7), ["packages/acquit-cli/src/main.ts", "submit", "job_7Q2K", "--dir", printed.repo]);
		assert.equal(existsSync(join(cwd, CANARY)), false, "a hostile TMPDIR must not run a command");
	} finally {
		stub.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		await rm(HOSTILE_TMPDIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		await rm(laneDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
