// The per-run mirror's contract: the installation token stays out of argv and out of every file, the
// submitted commit comes from the job's work repo, the frozen base falls back to the client repo, and
// every failure is a named code. The token rides in the fetch child's own git config, so a service
// killed mid-fetch leaves no credential behind.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommitSha, JobId } from "../src/ids.ts";
import { parseJobId } from "../src/ids.ts";
import { frozenDefinition } from "../src/seed-data.ts";
import type { VerifierRunRequest } from "../src/verifier.ts";
import { createRunSource, SourceUnavailable } from "../../verifier/fetch.ts";
import type { GitResult, RunSourceOptions } from "../../verifier/fetch.ts";

const token = "ghs_live_proof_token";
const submitted = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const frozen = frozenDefinition().frozenAt;
const jobId = parseJobId("job_source") as JobId;

function request(repository = "maya-client/invoice-app"): VerifierRunRequest {
	return { runId: "run_source_1" as VerifierRunRequest["runId"], jobId, ordinal: 1, sourceCommit: submitted,
		definitionOfDone: { ...frozenDefinition(), issue: { ...frozenDefinition().issue, repository } } };
}

/** A git runner that records what it was asked, with the mirror's config file as it stands at the call. */
function recorder(options: { readonly dir: string; readonly missing?: readonly string[]; readonly fail?: (args: readonly string[]) => GitResult | null }) {
	const calls: { args: readonly string[]; env: NodeJS.ProcessEnv; config: string }[] = [];
	const git: RunSourceOptions["git"] = (args, env) => {
		const config = (() => { try { return readFileSync(join(options.dir, "config"), "utf8"); } catch { return ""; } })();
		calls.push({ args: [...args], env, config });
		const failed = options.fail?.(args);
		if (failed) return failed;
		if (args.includes("cat-file")) return { status: options.missing?.some(commit => args.some(arg => arg.startsWith(commit))) ? 1 : 0, stdout: "", stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	};
	return { calls, git };
}

function mirror() {
	const dir = mkdtempSync(join(tmpdir(), "acquit-source-test-"));
	const original = "[core]\n\trepositoryformatversion = 0\n";
	writeFileSync(join(dir, "config"), original, { mode: 0o644 });
	return { dir, original, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the mirror fetches both commits with the token in the child's git config, never in argv or a file", async () => {
	const { dir, original, remove } = mirror();
	// The work repo carries the submitted commit but not the frozen base, so the mirror falls back to the client repo.
	const { calls, git } = recorder({ dir, missing: [frozen],
		fail: args => args.includes("fetch") && args.some(arg => arg === frozen) && args.some(arg => arg.includes("acquit-forks/"))
			? { status: 128, stdout: "", stderr: "fatal: not our ref" } : null });
	const source = createRunSource({ organization: "acquit-forks", tokenFor: async () => token, git, makeDir: () => dir, removeDir: () => {} });
	try {
		const built = await source(request());
		assert.deepEqual(Object.keys(built.source).sort(), ["diff", "materialize", "readFile"]);
		assert.equal(typeof built.remove, "function");
		const fetches = calls.filter(call => call.args.includes("fetch"));
		// The submitted commit from the work repo, the frozen base refused there, then the client repo.
		assert.equal(fetches.length, 3);
		assert.deepEqual(fetches.map(call => call.args.at(-2)), ["https://github.com/acquit-forks/invoice-app-source.git",
			"https://github.com/acquit-forks/invoice-app-source.git", "https://github.com/maya-client/invoice-app.git"]);
		for (const call of fetches) {
			assert.equal(call.args.some(arg => arg.includes(token)), false, "the token must never reach argv");
			// GitHub's git endpoint takes the installation token as a Basic user, not as a bearer token,
			// and git reads `http.<url>.extraHeader` from the child's own environment config.
			assert.equal(call.env.GIT_CONFIG_COUNT, "1");
			assert.equal(call.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
			const header = /Authorization: Basic ([A-Za-z0-9+/=]+)/.exec(String(call.env.GIT_CONFIG_VALUE_0));
			assert(header, "the fetch must carry an Authorization header");
			assert.equal(Buffer.from(header[1], "base64").toString("utf8"), `x-access-token:${token}`);
			// The mirror's own config is untouched while the fetch runs, so a SIGKILL leaves no credential.
			assert.equal(call.config, original);
		}
		// The mirror is handed to the judge without the token anywhere in it.
		assert.equal(readFileSync(join(dir, "config"), "utf8"), original);
	} finally { remove(); }
});

test("each run gets its own mirror directory, and the run removes it", async () => {
	// The real default makeDir and removeDir: mkdtemp per run, deleted when the run ends.
	const dirs: string[] = [];
	const git: RunSourceOptions["git"] = args => {
		if (args[0] === "-C" && !dirs.includes(args[1])) dirs.push(args[1]);
		return { status: 0, stdout: "", stderr: "" };
	};
	const source = createRunSource({ organization: "acquit-forks", tokenFor: async () => token, git });
	const first = await source(request());
	const second = await source(request());
	assert.equal(dirs.length, 2);
	assert.notEqual(dirs[0], dirs[1], "two runs must never share a mirror");
	assert.match(dirs[0], /acquit-mirror-run_source_1-/);
	assert.match(dirs[1], /acquit-mirror-run_source_1-/);
	assert.equal(existsSync(dirs[0]) && existsSync(dirs[1]), true);
	first.remove();
	assert.equal(existsSync(dirs[0]), false, "the first run's mirror is gone");
	assert.equal(existsSync(dirs[1]), true, "the second run's mirror is untouched");
	second.remove();
	assert.equal(existsSync(dirs[1]), false);
});

test("a fetch that fails names the commit and the repository it could not read", async () => {
	const { dir, remove } = mirror();
	const refused = recorder({ dir, fail: args => args.includes("fetch") ? { status: 128, stdout: "", stderr: "fatal: could not read Username\nmore" } : null });
	const source = createRunSource({ organization: "acquit-forks", tokenFor: async () => token, git: refused.git, makeDir: () => dir, removeDir: () => {} });
	try {
		await assert.rejects(() => source(request()), (error: unknown) => error instanceof SourceUnavailable
			&& error.code === "SUBMITTED_COMMIT_UNFETCHABLE" && /acquit-forks\/invoice-app-source 5cccb6651531/.test(error.message)
			&& /could not read Username more/.test(error.message));
	} finally { remove(); }
});

test("a git that cannot start is GIT_UNAVAILABLE, and a frozen base missing everywhere keeps its code", async () => {
	const { dir, remove } = mirror();
	const noGit = recorder({ dir, fail: args => args.includes("init") ? { status: null, stdout: "", stderr: "" } : null });
	try {
		await assert.rejects(() => createRunSource({ organization: "acquit-forks", tokenFor: async () => token, git: noGit.git,
			makeDir: () => dir, removeDir: () => {} })(request()),
			(error: unknown) => error instanceof SourceUnavailable && error.code === "GIT_UNAVAILABLE");
	} finally { remove(); }
	const second = mirror();
	const missingFrozen = recorder({ dir: second.dir, missing: [frozen], fail: args => args.includes("fetch") && args.some(arg => arg === frozen)
		? { status: 128, stdout: "", stderr: "fatal: not our ref" } : null });
	try {
		await assert.rejects(() => createRunSource({ organization: "acquit-forks", tokenFor: async () => token, git: missingFrozen.git,
			makeDir: () => second.dir, removeDir: () => {} })(request()),
			(error: unknown) => error instanceof SourceUnavailable && error.code === "FROZEN_COMMIT_UNFETCHABLE");
	} finally { second.remove(); }
});
