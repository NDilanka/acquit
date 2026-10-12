// The model provider switch and the droid client. Every app model call -- the House runner now,
// A3 "Ask the ledger" and A1 scoping later -- reads the same switch, `ACQUIT_MODEL_PROVIDER`,
// default `droid`. The droid client is pure logic: the exact `droid exec` argv the sandbox runs,
// the classification of the `-o json` result stream, and the in-process key lookup. No network, no
// Docker, no key value in a log: the key travels from `factoryApiKey` to the sandbox in-process,
// the way the provider key always has.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { boundedDetail } from "./verifier.ts";

/** The providers the switch can name. `droid` is the operator's ruled default; `openrouter` keeps
 * the path the M3 prototype proved, selectable for the hackathon submission. */
export type ModelProvider = "droid" | "openrouter";

export const MODEL_PROVIDER_ENV = "ACQUIT_MODEL_PROVIDER";

/** The one model every app model call runs under the droid provider, per the operator's ruling. */
export const DROID_MODEL = "glm-5.3-flash";

/** Where run.mjs (the sandbox entrypoint) writes the instruction it was handed in
 * ACQUIT_INSTRUCTION. The droid runner reads its prompt from a file (`-f`), never argv. */
export const DROID_INSTRUCTION_PATH = "/tmp/acquit-instruction.txt";

/** The provider this deployment runs: unset or `droid` is droid; `openrouter` selects the
 * OpenRouter path; anything else is a configuration error, never a silent fallback. */
export function modelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
	const named = env[MODEL_PROVIDER_ENV]?.trim().toLowerCase();
	if (named === undefined || named === "") return "droid";
	if (named === "droid" || named === "openrouter") return named;
	throw new Error(`${MODEL_PROVIDER_ENV} must be droid or openrouter, not ${JSON.stringify(env[MODEL_PROVIDER_ENV])}`);
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

/** The one provider error is everything a retry is for: an `is_error` result line (a 4xx/5xx the
 * API itself answered), or a nonzero exit without a result line (a transport failure). An exit 0
 * with no result line defers to the commit step, as the claude classification always has. */
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
		return { ok: false, reason: "PROVIDER_ERROR", detail: boundedDetail(detail) };
	}
	if (code === 0) return { ok: true, sessionId: null, factoryCredits: null };
	return { ok: false, reason: "PROVIDER_ERROR", detail: `the droid run exited ${code ?? "without a status"}` };
}

function factoryCreditsOf(usage: unknown): number | null {
	if (usage === null || typeof usage !== "object") return null;
	const credits = (usage as { factory_credits?: unknown }).factory_credits;
	return typeof credits === "number" && Number.isFinite(credits) ? credits : null;
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
