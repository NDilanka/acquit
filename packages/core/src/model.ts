// The model provider switch and the droid client. Every app model call -- the House runner now,
// A3 "Ask the ledger" and A1 scoping later -- reads the same switch, `ACQUIT_MODEL_PROVIDER`,
// default `fireworks`. The droid client is pure logic: the exact `droid exec` argv the sandbox runs,
// the classification of the `-o json` result stream, and the in-process key lookup. No network, no
// Docker, no key value in a log: the key travels from `factoryApiKey` to the sandbox in-process,
// the way the provider key always has.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { boundedDetail } from "./verifier.ts";

/** The providers the switch can name. `fireworks` is the default: the product's own model calls (Ask and
 * scoping) run through the fetch-based chat-completions client in `llm.ts`. `droid` and `openrouter` keep
 * their paths working; the House coding agent stays on droid unless it is explicitly given openrouter. */
export type ModelProvider = "fireworks" | "droid" | "openrouter";

export const MODEL_PROVIDER_ENV = "ACQUIT_MODEL_PROVIDER";

/** The one model every app model call runs under the droid provider, per the operator's ruling. */
export const DROID_MODEL = "glm-5.3-flash";

/** Where run.mjs (the sandbox entrypoint) writes the instruction it was handed in
 * ACQUIT_INSTRUCTION. The droid runner reads its prompt from a file (`-f`), never argv. */
export const DROID_INSTRUCTION_PATH = "/tmp/acquit-instruction.txt";

/** The provider this deployment runs: unset is fireworks; `droid` and `openrouter` select their paths;
 * anything else is a configuration error, never a silent fallback. */
export function modelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
	const named = env[MODEL_PROVIDER_ENV]?.trim().toLowerCase();
	if (named === undefined || named === "") return "fireworks";
	if (named === "fireworks" || named === "droid" || named === "openrouter") return named;
	throw new Error(`${MODEL_PROVIDER_ENV} must be fireworks, droid, or openrouter, not ${JSON.stringify(env[MODEL_PROVIDER_ENV])}`);
}

/** The `droid exec` argv a model run executes inside the sandbox: medium autonomy, the pinned
 * model, json output so the result can be classified, the job work tree, and the prompt by file.
 * Medium, not low, because at low droid exec ends early with an insufficient-permission error
 * when the model runs the required tests, and permission rules cannot cover its chained or
 * redirected command spellings; the sandbox and egress allowlist remain the security boundary. */
export function droidExecArgv({ model, workDir = "/work" }: { readonly model: string; readonly workDir?: string }): readonly string[] {
	return ["droid", "exec", "--auto", "medium", "-m", model, "-o", "json", "--cwd", workDir, "-f", DROID_INSTRUCTION_PATH];
}

// ---- the droid result --------------------------------------------------------------------------

export type DroidRunResult =
	| { readonly ok: true; readonly sessionId: string | null; readonly factoryCredits: number | null }
	| { readonly ok: false; readonly reason: "PROVIDER_ERROR" | "RATE_LIMITED"; readonly detail: string;
		/** What the failed run still reported, when the provider's own result line carried it. */
		readonly sessionId?: string | null; readonly factoryCredits?: number | null };

/** The `-o json` result line droid exec prints, or null. */
type DroidResultLine = {
	readonly is_error?: unknown;
	readonly result?: unknown;
	readonly session_id?: unknown;
	readonly usage?: unknown;
};

/** A Factory rate or usage limit answers in the provider's own error text; the operator's rule
 * makes it terminal for the whole run, so the class is named on the result and never retried. */
const RATE_LIMITED_PATTERN = /rate.?limit|usage limit|quota|too many requests|429|insufficient credit/i;

/** The one provider error is everything a retry is for: an `is_error` result line (a 4xx/5xx the
 * API itself answered), or a nonzero exit without a result line (a transport failure). An exit 0
 * with no result line defers to the commit step, as the claude classification always has. A rate
 * or usage limit is the exception: its own terminal class, and the metadata the answer carried
 * (the session it spent, the credits it reported) survives on the error either way. */
export function classifyDroidRun(code: number | null, output: string): DroidRunResult {
	const result = parseDroidResult(output);
	if (result !== null && result.is_error === false) {
		return {
			ok: true,
			sessionId: typeof result.session_id === "string" && result.session_id !== "" ? result.session_id : null,
			factoryCredits: factoryCreditsOf(result.usage),
		};
	}
	if (result !== null && result.is_error === true) {
		const detail = typeof result.result === "string" && result.result.trim() !== "" ? result.result.trim() : "the droid result line reported an error";
		const shared = {
			sessionId: typeof result.session_id === "string" && result.session_id !== "" ? result.session_id : null,
			factoryCredits: factoryCreditsOf(result.usage),
		};
		if (RATE_LIMITED_PATTERN.test(detail)) return { ok: false, reason: "RATE_LIMITED", detail: boundedDetail(detail), ...shared };
		return { ok: false, reason: "PROVIDER_ERROR", detail: boundedDetail(detail), ...shared };
	}
	if (code === 0) return { ok: true, sessionId: null, factoryCredits: null };
	if (RATE_LIMITED_PATTERN.test(output)) {
		return { ok: false, reason: "RATE_LIMITED", detail: `the droid run exited ${code ?? "without a status"}` };
	}
	return { ok: false, reason: "PROVIDER_ERROR", detail: `the droid run exited ${code ?? "without a status"}` };
}

function factoryCreditsOf(usage: unknown): number | null {
	if (usage === null || typeof usage !== "object") return null;
	const credits = (usage as { factory_credits?: unknown }).factory_credits;
	return typeof credits === "number" && Number.isFinite(credits) ? credits : null;
}

/** The answer text a finished run's result line carried, or null. A read-only ask turn's whole
 * product is that text; a delivery's product is the commit it pushed, which is why this is its
 * own read instead of a field on the classification. */
export function droidResultText(output: string): string | null {
	const result = parseDroidResult(output);
	return result !== null && typeof result.result === "string" && result.result.trim() !== "" ? result.result : null;
}

/** The last `{"type":"result",...}` line the droid CLI prints, or null. */
function parseDroidResult(output: string): DroidResultLine | null {
	const lines = output.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "result") {
				return parsed as DroidResultLine;
			}
		} catch { /* a non-JSON line; keep scanning back */ }
	}
	return null;
}

// ---- the shared model-call budget --------------------------------------------------------------

/** The operator's approved budget for app model calls: under 20 a minute and under 1000 a day.
 * A window therefore admits its 19th call (minute) and its 999th (day), and nothing further. */
export const MODEL_CALLS_MINUTE = 20;
export const MODEL_CALLS_DAY = 1000;

/** A caller group's own ceiling inside the shared budget, named for its refusal. Its calls count against the group's
 * windows and against the global ones, and a group at its ceiling is refused while the global capacity it leaves stays
 * for every caller outside the group. Calls from outside the group are not counted against the group. */
export type ModelCallAllowance = { readonly name: string; readonly callers: readonly string[]; readonly perMinute: number; readonly perDay: number };

/** One line of the call log every app model call shares. The START record is written before the
 * caller runs anything; the END record carries the outcome and the usage the answer reported. */
export type ModelCallRecord = {
	readonly at: string;
	readonly caller: string;
	readonly jobId: string | null;
	readonly provider: string;
	readonly model: string;
	readonly phase: "START" | "END";
	readonly outcome?: string;
	readonly sessionId?: string | null;
	readonly factoryCredits?: number | null;
	/** The provider's request id and token usage for a chat-completions attempt; null or absent for the other providers. */
	readonly requestId?: string | null;
	readonly usage?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number } | null;
};

export type ModelCallLog = {
	/** The log's own path. The budget's lock file derives from it, so every process that reads
	 * and appends through this log waits on the same lock. */
	readonly path: string;
	readonly append: (record: ModelCallRecord) => Promise<void>;
	readonly records: () => Promise<readonly ModelCallRecord[]>;
};

/** The durable, append-only call log (one JSON line per record, mode 600) the shared budget reads:
 * `model-calls.jsonl` beside the database, so every caller in this deployment counts together. */
export function modelCallLog(path: string): ModelCallLog {
	return {
		path,
		async append(record) {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		},
		async records() {
			let raw: string;
			try {
				raw = await readFile(path, "utf8");
			} catch {
				return [];
			}
			return raw.split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line) as ModelCallRecord);
		},
	};
}

/** The reservation's critical section -- read the log, count the windows, append the START -- is
 * atomic for every caller that shares the budget: concurrent Ask requests and the House scan
 * today, in this process or in separate ones. The lock is a lock file taken with O_EXCL
 * (`open(.., "wx")`), which the kernel serializes across processes and threads alike; a plain
 * in-process mutex would leave two processes both reading the same count. The holder writes a
 * unique owner token (pid + random) into the file it creates, and its release removes the path
 * only while the file still holds that token, so nobody but the lock's own owner ever removes a
 * live lock. There is no stale takeover: an age can never tell a dead holder from a live one
 * that merely stalled, and every takeover step opens a schedule where two callers end up
 * counting the same window. A holder that died wedges the waiters instead -- each waits a
 * bounded time, then refuses with BUDGET and never proceeds uncounted -- and recovery is the
 * operator's: `node packages/ctl/src/main.ts model-lock clear` removes the lock once the pid it
 * records is gone from this host. */
const BUDGET_LOCK_TIMEOUT_MS = 5_000;

/** The budget's lock file: the call log's own path plus `.lock`, so every reader of the log waits
 * on exactly the lock its writers hold. */
export function modelCallLockPath(logPath: string): string {
	return `${logPath}.lock`;
}

const budgetLockWait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

const budgetLockToken = (): string => `${process.pid}.${randomBytes(8).toString("hex")}`;

/** The lock-wait deadline's own outcome: the caller refuses the reservation, it does not error. */
class BudgetLockTimeout extends Error {}

async function withBudgetLock<T>(lockPath: string, critical: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + BUDGET_LOCK_TIMEOUT_MS;
	for (;;) {
		let handle: FileHandle;
		try {
			handle = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new BudgetLockTimeout(`the model-call budget lock never freed: ${lockPath};`
					+ ` recover with: node packages/ctl/src/main.ts model-lock clear`);
			}
			await budgetLockWait(2 + Math.floor(Math.random() * 6));
			continue;
		}
		const token = budgetLockToken();
		try {
			await handle.write(token, 0, "utf8");
			return await critical();
		} finally {
			await handle.close();
			await releaseBudgetLock(lockPath, token);
		}
	}
}

/** Release removes the lock only while the path still holds this holder's token: an operator's
 * clear plus a re-acquire can have replaced the file, and the new owner's lock must survive. */
async function releaseBudgetLock(lockPath: string, token: string): Promise<void> {
	try {
		if (await readFile(lockPath, "utf8") !== token) return;
		await rm(lockPath, { force: true });
	} catch {
		// gone already: there is nothing of ours left to remove
	}
}

/** Reserves one model call at `call.at` when the shared budget allows it, writing the call's START
 * record before the caller runs anything, so crashes, failures, and retries all count. Refuses
 * when the rolling minute already holds its 19 calls or the day its 999, and, for a call from an
 * allowance's group, when that group's own windows are full. `call.at` is the wall
 * clock -- the dev offset clock used for domain deadlines never reaches the budget. The windows
 * are always re-read inside the lock, and that re-read decides; the unlocked read first only
 * spares the lock when the answer is already no. A waiter that never gets the lock refuses with
 * BUDGET too, and that refusal carries the message naming the lock path and the operator's
 * recovery command. */
export async function reserveModelCall(log: ModelCallLog, call: Omit<ModelCallRecord, "phase">, allowance?: ModelCallAllowance):
Promise<{ ok: true } | { ok: false; reason: "BUDGET"; detail?: string }> {
	const at = Date.parse(call.at);
	const refused = (detail?: string) => ({ ok: false as const, reason: "BUDGET" as const, ...(detail === undefined ? {} : { detail }) });
	// The global windows first, then the caller group's own windows when this call belongs to the group. Both are read
	// inside the lock below, so the group's ceiling and the global caps are decided by the same count.
	const overBudget = async (): Promise<ReturnType<typeof refused> | null> => {
		const starts = (await log.records()).filter(record => record.phase === "START");
		const within = (records: readonly ModelCallRecord[], span: number) => records.filter(record => Date.parse(record.at) > at - span).length;
		if (within(starts, 60_000) >= MODEL_CALLS_MINUTE - 1 || within(starts, 86_400_000) >= MODEL_CALLS_DAY - 1) return refused();
		if (allowance?.callers.includes(call.caller) === true) {
			const group = starts.filter(record => allowance.callers.includes(record.caller));
			if (within(group, 60_000) >= allowance.perMinute || within(group, 86_400_000) >= allowance.perDay) {
				return refused(`the ${allowance.name} allowance inside the shared model budget is spent for now`);
			}
		}
		return null;
	};
	const early = await overBudget();
	if (early !== null) return early;
	try {
		return await withBudgetLock(modelCallLockPath(log.path), async (): Promise<{ ok: true } | ReturnType<typeof refused>> => {
			const held = await overBudget();
			if (held !== null) return held;
			await log.append({ ...call, phase: "START" });
			return { ok: true };
		});
	} catch (error) {
		if (error instanceof BudgetLockTimeout) return { ok: false, reason: "BUDGET", detail: error.message };
		throw error;
	}
}

// ---- the Factory key ---------------------------------------------------------------------------

/** The laptop key file the mission names. The VM never reads it: there the key arrives in the
 * `FACTORY_API_KEY` environment of the acquit-api unit, from the root-owned secrets file. */
export function factoryApiKeyPath(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME?.trim() !== "" && env.HOME !== undefined ? env.HOME : homedir();
	return join(home, ".config", "acquit", "factory-api-key");
}

/** The Factory API key for a droid run: the `FACTORY_API_KEY` environment first, then the laptop
 * key file, read in-process and never logged. Null when neither holds a usable single-line key. */
export async function factoryApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const fromEnv = env.FACTORY_API_KEY?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	try {
		const key = (await readFile(factoryApiKeyPath(env), "utf8")).trim();
		return key === "" || /[\r\n]/.test(key) ? null : key;
	} catch {
		return null;
	}
}
