// The A1 scoping layer. On OpenJob of a fixture that carries a trusted fix, the deployment drafts
// the acceptance contract and its hidden cases with the pinned model, runs Prototype C's four
// filters against the real frozen and fix commits, and parks the survivors for the client's
// approval. The store row holds ids and counts only; the case values live in the deployment's
// private scoping store, one file per job, mode 600. A draft that cannot finish — a provider
// error, a malformed answer, a draft every filter drops — freezes nothing and is never retried.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DROID_MODEL, modelProvider, reserveModelCall } from "../../../packages/core/src/model.ts";
import type { ModelCallLog } from "../../../packages/core/src/model.ts";
import type { CurrencyFamily, FixtureContract } from "../../../packages/core/src/fixtures.ts";
import type { Instant, JobId, TestId } from "../../../packages/core/src/ids.ts";
import { parseScopeDraft, runScopeFilters, ScopeDraftError } from "../../../packages/core/src/scoping.ts";
import type { JobScopingRow, ScopePhaseOutcome, ScopePhaseRunner } from "../../../packages/core/src/scoping.ts";
import { parseSubjectTranscript, toSubjectCall } from "../../../packages/core/src/verifier.ts";
import type { SubjectCall } from "../../../packages/core/src/verifier.ts";
import { gitSource } from "../../../packages/verifier/judge.ts";
import { subjectFor, verifierSubjectEnv } from "../../../packages/verifier/subject.ts";
import type { SubjectLauncher } from "../../../packages/verifier/subject.ts";
import { droidAskPort, openrouterAskPort } from "./ask.ts";
import type { AskModelPort, AskModelResult } from "./ask.ts";
import { HOUSE_MODEL_OPENROUTER } from "../../../packages/house/src/runner.ts";
import type { TokenPort } from "../../../packages/core/src/github.ts";

/** The issue body read the draft scopes from: the repository and issue, and the body text. */
export type IssueBodyPort = (issue: { readonly repository: string; readonly number: number }) => Promise<string | null>;

/** The model id the scoping draft runs on, per the deployment's provider switch. */
export function scopeModelName(env: NodeJS.ProcessEnv = process.env): string {
	return modelProvider(env) === "openrouter" ? HOUSE_MODEL_OPENROUTER : DROID_MODEL;
}

/** The scoping model port: the provider switch. Droid is the default and runs read-only — no
 * --auto, json output, the prompt by file, the Factory key in process. The openrouter path keeps
 * the :free id and is tested with injected transports only; this mission makes no live openrouter
 * call. */
export function scopeDraftModel(deps: { readonly env?: NodeJS.ProcessEnv } = {}): AskModelPort {
	return modelProvider(deps.env ?? process.env) === "openrouter" ? openrouterAskPort(deps) : droidAskPort(deps);
}

/** A scoping turn's answer: the model port's own result, plus the budget's refusal class. */
export type ScopeTurnResult = { readonly ok: true; readonly text: string; readonly sessionId: string | null; readonly factoryCredits: number | null }
	| { readonly ok: false; readonly reason: "PROVIDER_ERROR" | "RATE_LIMITED" | "NO_KEY" | "BUDGET"; readonly detail: string;
		readonly sessionId?: string | null; readonly factoryCredits?: number | null };

/** One scoping model turn: reserve from the deployment's shared budget, call once, record the END.
 * A provider error gets no second call here — the scoping draft is a background convenience, and
 * a retry loop would spend the budget drafting the same job twice. */
export async function scopeDraftTurn(deps: { readonly model: AskModelPort; readonly callLog: ModelCallLog; readonly jobId: JobId | null },
	prompt: string): Promise<ScopeTurnResult> {
	const provider = modelProvider();
	const model = scopeModelName();
	const at = (): string => new Date().toISOString();
	// The budget's lock file lives beside the log; make sure the directory is there before the
	// reservation asks for it.
	await mkdir(dirname(deps.callLog.path), { recursive: true });
	const reserved = await reserveModelCall(deps.callLog, { at: at(), caller: "scoping", jobId: deps.jobId, provider, model });
	if (!reserved.ok) return { ok: false, reason: "BUDGET", detail: reserved.detail ?? "the deployment's shared model budget is spent for now" };
	const result = await deps.model(prompt);
	await deps.callLog.append({ at: at(), caller: "scoping", jobId: deps.jobId, provider, model, phase: "END",
		outcome: result.ok ? "answered" : result.reason, sessionId: result.sessionId ?? null, factoryCredits: result.factoryCredits ?? null });
	return result;
}

export type ScopingKickDeps = {
	readonly store: { readonly readScoping: (jobId: JobId) => Promise<JobScopingRow | null>; readonly writeScoping: (row: JobScopingRow) => Promise<void> };
	/** The fixture the kick is for: its repository, issue, frozen commit, trusted fix, and gate. */
	readonly fixture: FixtureContract;
	readonly issueBody: (issue: { readonly repository: string; readonly number: number }) => Promise<string | null>;
	readonly model: (prompt: string) => Promise<AskModelResult>;
	readonly callLog: ModelCallLog;
	readonly runPhase: ScopePhaseRunner;
	/** The deployment's private scoping store: one file per job, beside the registry, never in git. */
	readonly scopingDir: string;
	readonly clock: { readonly now: () => Instant };
	readonly log?: (line: string) => void;
};

const scopePrompt = (input: { readonly body: string; readonly fixture: FixtureContract; readonly families: readonly CurrencyFamily[] }): string => {
	const families = input.families.length === 0 ? "" : `\nCoverage: the draft must carry at least one case for every family: ${input.families.map(f => `${f.name} (${f.currencies.join(", ")})`).join("; ")}.`;
	return `You draft an acceptance contract for one issue. Reply with ONE JSON object and nothing else:
{"contract": "<at most 4000 chars of prose>",
 "candidates": [{"id": "<unique>", "target": {"module": "<file>", "export": "<name>"},
                 "args": [<json values>], "expected": <json value>, "citation": "<quoted words from the issue that justify the expected value>"}]}
Rules: 2 to 12 candidates; every candidate must FAIL on the frozen commit and PASS on the trusted
fix; every expected value must be justified by words you quote from the issue body; args must be
bounded JSON; ids unique and at most 64 characters.
${families}
## Repository and commits
Repository: ${input.fixture.repository}
Frozen commit (every case must fail here): ${input.fixture.frozenAt}
Trusted fix commit (every case must pass here): ${input.fixture.trustedFix ?? "(none declared)"}
The frozen suite is ${input.fixture.frozenTestPath}; the module you call lives in the repository tree at those commits.
## Issue
${input.body}`;
};

/** The OpenJob kickoff: draft once, park it, and never fail the open. Every path writes the row. */
export function scopingKick(deps: ScopingKickDeps): (jobId: JobId) => Promise<void> {
	const say = deps.log ?? ((): void => {});
	return async jobId => {
		try {
			// One draft per job, ever: the row is the guard a replayed open or a second kick reads.
			if (await deps.store.readScoping(jobId) !== null) return;
			await deps.store.writeScoping({ jobId, status: "DRAFTING", issueBody: null, ids: [], digest: null, reason: null, counts: null, updatedAt: deps.clock.now() });
			const body = await deps.issueBody({ repository: deps.fixture.repository, number: deps.fixture.issue.number });
			if (body === null) {
				await deps.store.writeScoping({ jobId, status: "FAILED", issueBody: null, ids: [], digest: null, reason: "ISSUE_BODY_UNREADABLE", counts: null, updatedAt: deps.clock.now() });
				say(`scoping ${jobId}: the issue body never arrived; nothing was drafted`);
				return;
			}
			const answer = await scopeDraftTurn({ model: deps.model, callLog: deps.callLog, jobId }, scopePrompt({ body, fixture: deps.fixture, families: deps.fixture.coverageFamilies ?? [] }));
			if (!answer.ok) {
				await deps.store.writeScoping({ jobId, status: "FAILED", issueBody: body, ids: [], digest: null, reason: `DRAFT_${answer.reason}`, counts: null, updatedAt: deps.clock.now() });
				say(`scoping ${jobId}: the draft turn failed (${answer.reason}); nothing was frozen and nothing will retry`);
				return;
			}
			let draft;
			try {
				draft = parseScopeDraft(answer.text);
			} catch (error) {
				const reason = error instanceof ScopeDraftError ? `MALFORMED_DRAFT: ${error.message}` : "MALFORMED_DRAFT";
				await deps.store.writeScoping({ jobId, status: "FAILED", issueBody: body, ids: [], digest: null, reason, counts: null, updatedAt: deps.clock.now() });
				say(`scoping ${jobId}: ${reason}; nothing was frozen and nothing will retry`);
				return;
			}
			const counts = await runScopeFilters(draft, {
				frozenAt: deps.fixture.frozenAt, trustedFix: deps.fixture.trustedFix ?? deps.fixture.frozenAt,
				issueBody: body, runPhase: deps.runPhase,
			});
			// Product ids replace the model's: the stored set is draft:1..n in the draft's own order,
			// so a review can name a case without trusting the model's id choices.
			const survivors = counts.survivors.map((candidate, index) =>
				({ ...candidate, id: `draft:${index + 1}` }));
			if (survivors.length === 0) {
				await deps.store.writeScoping({ jobId, status: "FAILED", issueBody: body, ids: [], digest: null,
					reason: `NO_CASE_SURVIVED: ${JSON.stringify(counts.counts)}`, counts: counts.counts, updatedAt: deps.clock.now() });
				say(`scoping ${jobId}: no case survived the four filters; nothing was frozen and nothing will retry`);
				return;
			}
			const cases = survivors.map(candidate =>
				({ id: candidate.id, target: candidate.target, args: candidate.args, expected: candidate.expected, citation: candidate.citation }));
			await mkdir(deps.scopingDir, { recursive: true, mode: 0o700 });
			await writeFile(join(deps.scopingDir, `${jobId}.json`), JSON.stringify({
				version: 1, jobId, repository: deps.fixture.repository, issue: { number: deps.fixture.issue.number, title: deps.fixture.issue.title },
				frozenAt: deps.fixture.frozenAt, contract: draft.contract, approved: null, cases,
			}, null, "\t"), { mode: 0o600, encoding: "utf8" });
			await deps.store.writeScoping({ jobId, status: "AWAITING_APPROVAL", issueBody: body, ids: cases.map(test => test.id as TestId),
				digest: null, reason: null, counts: counts.counts, updatedAt: deps.clock.now() });
			say(`scoping ${jobId}: ${cases.length} case(s) parked for the client's approval`);
		} catch (error) {
			// A kick never fails the open that started it. The row says FAILED; the operator reads why.
			say(`scoping ${jobId}: the draft pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
			try {
				await deps.store.writeScoping({ jobId, status: "FAILED", issueBody: null, ids: [], digest: null,
					reason: "PIPELINE_ERROR", counts: null, updatedAt: deps.clock.now() });
			} catch { /* the row already said DRAFTING; the log line above is the record */ }
		}
	};
}

// ---- the real ports: the phases' two commits, and the issue body --------------------------------

/** The subject replies one commit's phase read out of its transcript, or a dropped case. */
const repliesOf = (stdout: string, nonce: string, calls: readonly SubjectCall[]): ReadonlyMap<TestId, ScopePhaseOutcome> => {
	const { replies } = parseSubjectTranscript(stdout, nonce, calls);
	const outcomes = new Map<TestId, ScopePhaseOutcome>();
	for (const call of calls) {
		const reply = replies.get(call.id);
		outcomes.set(call.id, reply === undefined ? { ok: false, value: null, error: "no reply" }
			: reply.ok ? { ok: true, value: reply.value, error: null } : { ok: false, value: null, error: reply.error });
	}
	return outcomes;
};

/** The scoping phase runner: one private mirror of the client repository per phase, the frozen and
 * fix commits fetched into it, the subject run against the extracted tree. The installation token
 * rides in the fetch child's own environment, exactly as a verifier run's fetch does. `remoteOf`
 * names the fetch URL (the GitHub default); a test points it at a local mirror. */
export function scopingPhaseRunner(deps: { readonly repository: string; readonly tokenFor: (owner: string) => Promise<string>;
	readonly subject?: SubjectLauncher; readonly remoteOf?: (repository: string) => string }): ScopePhaseRunner {
	const remote = deps.remoteOf ?? (repository => `https://github.com/${repository}.git`);
	const git = (args: readonly string[], env: NodeJS.ProcessEnv): void => {
		const result = spawnSync("git", [...args], { encoding: "utf8", timeout: 60_000, env });
		if (result.status !== 0) throw new Error(`git ${String(args[0])} failed: ${String(result.stderr).slice(0, 200)}`);
	};
	return async (commit, cases) => {
		const calls = cases.map(toSubjectCall);
		const dir = mkdtempSync(join(tmpdir(), "acquit-scope-phase-"));
		try {
			git(["-C", dir, "init", "--bare", "--quiet"], { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
			const token = await deps.tokenFor(deps.repository.split("/")[0]!);
			const credential = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
			git(["-C", dir, "-c", "credential.helper=", "fetch", "--no-tags", "--quiet", remote(deps.repository), commit],
				{ PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Basic ${credential}` });
			const source = gitSource(dir);
			const tree = source.materialize(commit);
			try {
				const launcher = deps.subject ?? subjectFor(verifierSubjectEnv());
				const run = await launcher.run(tree.path, calls);
				return repliesOf(run.stdout, run.nonce, calls);
			} finally { tree.remove(); }
		} finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
	};
}

/** The issue body port: the installation token's own REST read of the one issue the contract froze.
 * Null when GitHub refuses or the body is empty — the draft then parks FAILED and nothing freezes. */
export function issueBodyFetcher(deps: { readonly app: TokenPort; readonly apiBase: string }): IssueBodyPort {
	return async issue => {
		const [owner, name] = [issue.repository.split("/")[0]!, issue.repository.split("/")[1]!];
		try {
			const token = await deps.app.installationToken(owner, [name]);
			const response = await fetch(`${deps.apiBase}/repos/${issue.repository}/issues/${issue.number}`, {
				headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "acquit-scoping" },
				signal: AbortSignal.timeout(30_000), redirect: "error" });
			if (!response.ok) return null;
			const payload = await response.json() as { body?: unknown };
			return typeof payload.body === "string" && payload.body.trim() !== "" ? payload.body : null;
		} catch {
			return null;
		}
	};
}
