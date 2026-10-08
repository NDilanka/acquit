// `acquit operator init`: read the merchant status the API already holds, open PayPal onboarding when
// it is still pending, then take the model provider key — and, for OpenRouter, the model — and store
// them in the OS keychain. The key is read from a prompt or from stdin; it is never written to a file,
// a log line, argv, or the API.

import { CliError, apiFlag, resolveToken, readLogin } from "./client.ts";
import type { ApiClient } from "./client.ts";
import { PROVIDER, PROVIDER_KEY, PROVIDER_MODEL } from "./keychain.ts";
import type { Keychain } from "./keychain.ts";

/** The providers a stored key can run. */
export type Provider = "anthropic" | "openrouter";

export type ProviderSpec = {
	readonly label: string;            // "Anthropic", "OpenRouter"
	readonly host: string;             // the one provider host the proxy allows
	readonly keyVar: string;           // the env var that carries the key, passed by name only
	readonly defaultModel: string | null;
	readonly fixedEnv: (model: string | null) => Readonly<Record<string, string>>; // non-secret values
};

const OPENROUTER_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

/**
 * The provider table `run.ts` and the proxy read: one row per runnable provider. Anthropic keeps the
 * key variable and environment Claude Code had before OpenRouter existed, so its runs are unchanged;
 * OpenRouter pins its base URL and its model on every Claude Code model variable, because the model
 * must be named before the first request. The proxy is told one host from this table by name.
 */
export const PROVIDER_SPECS: Readonly<Record<Provider, ProviderSpec>> = {
	anthropic: {
		label: "Anthropic",
		host: "api.anthropic.com",
		keyVar: "ANTHROPIC_API_KEY",
		defaultModel: null,
		fixedEnv: () => ({}),
	},
	openrouter: {
		label: "OpenRouter",
		host: "openrouter.ai",
		keyVar: "ANTHROPIC_AUTH_TOKEN",
		defaultModel: OPENROUTER_DEFAULT_MODEL,
		fixedEnv: model => {
			const pinned = model ?? OPENROUTER_DEFAULT_MODEL;
			return {
				ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_MODEL: pinned,
				ANTHROPIC_DEFAULT_OPUS_MODEL: pinned,
				ANTHROPIC_DEFAULT_SONNET_MODEL: pinned,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: pinned,
				CLAUDE_CODE_SUBAGENT_MODEL: pinned,
			};
		},
	},
};

/**
 * The provider a stored name names. Nothing stored, or a name this build does not know, is Anthropic:
 * every earlier build stored only anthropic, and an unknown name must not widen what a run may reach.
 */
export function storedProvider(value: string | null | undefined): Provider {
	return value === "openrouter" ? "openrouter" : "anthropic";
}

/** What a run needs from the keychain: which provider and model the operator stored, and its key. */
export type ProviderPort = {
	getProvider(): Promise<{ readonly provider: Provider; readonly model: string | null }>;
	/** The stored key, or null. A runner that needs none never reads it. */
	getKey(): Promise<string | null>;
};

/** Wires the OS keychain behind the runner's provider port; the root passes this to `run.ts`. */
export function providerPort(keychain: Keychain): ProviderPort {
	return {
		async getProvider() {
			const model = keychain.get(PROVIDER_MODEL);
			return { provider: storedProvider(keychain.get(PROVIDER)), model: model === null || model.trim() === "" ? null : model };
		},
		async getKey() { return keychain.get(PROVIDER_KEY); },
	};
}

/** One answer from a question. `echoed` is true when the terminal itself put the typed line on screen. */
export type AskAnswer = {
	readonly value: string;
	readonly echoed: boolean;
};

export type OperatorInitOptions = {
	readonly apiUrl: string;
	readonly token: string;
	readonly provider: Provider | null;
	readonly model: string | null;
	readonly keyOnStdin: boolean;
	readonly timeoutSeconds: number;
	readonly pollMs: number;
};

export type OperatorInitDeps = {
	readonly client: ApiClient;
	readonly keychain: Keychain;
	/**
	 * Reads one answer. The question is already on stdout, so this only collects the value, and
	 * `echoed` says whether the terminal itself already put the typed answer on the screen.
	 */
	readonly ask: (question: string, secret: boolean) => Promise<AskAnswer>;
	readonly readStdin: () => string;
	readonly open: (url: string) => void;
	readonly write: (text: string) => void;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
};

type Onboarding = {
	readonly handle: string;
	readonly payouts: string;
	readonly onboardingUrl: string | null;
	readonly account: string | null;
	readonly identityVerified: boolean;
	readonly credits: { readonly available: number } | null;
};

function providerOf(value: string): Provider {
	// Only Anthropic and OpenRouter keys reach a runner today, so storing an OpenAI one would store a
	// key that nothing can use.
	if (value === "openai") throw new CliError("PROVIDER_UNSUPPORTED", "Only an Anthropic or OpenRouter key runs today.");
	if (value === "anthropic" || value === "openrouter") return value;
	throw new CliError("USAGE", "The provider must be anthropic or openrouter.");
}

export function parseOperatorArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): OperatorInitOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	if (rest[0] !== "init") {
		throw new CliError("USAGE", "Usage: acquit operator init [--provider anthropic|openrouter] [--model <id>] [--provider-key-stdin] [--api <url>]");
	}
	let provider: Provider | null = null;
	let model: string | null = null;
	let keyOnStdin = false;
	let timeoutSeconds = 600;
	for (let index = 1; index < rest.length; index++) {
		const flag = rest[index];
		if (flag === "--provider" || flag === "--timeout" || flag === "--model") {
			const next = rest[++index];
			if (next === undefined) throw new CliError("USAGE", `${flag} needs a value.`);
			if (flag === "--provider") provider = providerOf(next);
			else if (flag === "--model") {
				model = next.trim();
				if (model === "") throw new CliError("USAGE", "--model needs a model id.");
			} else timeoutSeconds = Number(next);
		} else if (flag === "--provider-key-stdin") keyOnStdin = true;
		else throw new CliError("USAGE", `Unknown flag ${flag}.`);
	}
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new CliError("USAGE", "--timeout takes whole seconds.");
	if (keyOnStdin && provider === null) throw new CliError("USAGE", "--provider-key-stdin needs --provider anthropic or openrouter.");
	if (model !== null && provider !== "openrouter") throw new CliError("USAGE", "--model needs --provider openrouter.");
	return { apiUrl, token: resolveToken(undefined, env, () => readLogin(env)?.token ?? null), provider, model, keyOnStdin, timeoutSeconds, pollMs: 1_000 };
}

async function readOnboarding(deps: OperatorInitDeps): Promise<Onboarding> {
	const body = await deps.client.get("/api/me/onboarding") as { onboarding?: Onboarding } | null;
	if (!body?.onboarding) throw new CliError("NOT_OPERATOR", "This account is not an operator. Sign in with an operator account and rerun.");
	return body.onboarding;
}

/**
 * Writes every line as it happens, so the payouts wait shows the onboarding URL while the browser
 * window is open, and returns the whole block for the transcript.
 */
export async function runOperatorInit(options: OperatorInitOptions, deps: OperatorInitDeps): Promise<string> {
	const lines: string[] = [];
	const emit = (line: string): void => { lines.push(line); deps.write(`${line}\n`); };
	const sleep = deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
	const now = deps.now ?? Date.now;

	emit("1/3 Payouts");
	let onboarding = await readOnboarding(deps);
	if (onboarding.payouts !== "READY") {
		if (!onboarding.onboardingUrl) {
			throw new CliError("ONBOARDING_NOT_STARTED",
				"PayPal payouts onboarding has not started for this operator. Connect payouts in the Acquit web app, then rerun `acquit operator init`.");
		}
		emit("\tOpening PayPal onboarding in your browser...");
		deps.open(onboarding.onboardingUrl);
		const deadline = now() + options.timeoutSeconds * 1_000;
		while (onboarding.payouts !== "READY") {
			if (now() >= deadline) {
				throw new CliError("ONBOARDING_TIMEOUT", "PayPal onboarding was not finished in time. Rerun `acquit operator init` when it is.");
			}
			await sleep(options.pollMs);
			onboarding = await readOnboarding(deps);
		}
	}
	emit(`\tConnected: ${onboarding.account ?? "PayPal merchant"}`);
	emit("2/3 Identity check");
	if (!onboarding.identityVerified) {
		throw new CliError("IDENTITY_PENDING", "PayPal has not verified this operator's identity yet. Rerun `acquit operator init` after it does.");
	}
	emit("\tPayPal verified your identity during onboarding.");
	emit("3/3 Model provider");

	const question = "\tProvider (anthropic): ";
	// The terminal already echoed the answer when `echoed` is set, so writing it again would print it
	// twice; a pipe and the hidden key prompt echo nothing and still need the line. The transcript
	// keeps the whole line either way.
	const answerLine = (prompt: string, answer: string, echoed: boolean): void => {
		if (!echoed) deps.write(`${answer}\n`);
		lines.push(`${prompt}${answer}`);
	};
	let provider = options.provider;
	if (provider === null) {
		deps.write(question);
		const answer = await deps.ask(question, false);
		const typed = answer.value.trim();
		provider = typed === "" ? "anthropic" : providerOf(typed);
		// A blank answer leaves the terminal showing a bare prompt line; reprint the whole line over it
		// so the screen names the default the blank became, exactly as the tutorial shows it.
		if (answer.echoed && typed === "") deps.write(`\x1b[1A\r${question}${provider}\n`);
		answerLine(question, provider, answer.echoed);
	} else emit(`${question}${provider}`);

	// Only OpenRouter needs a model named up front. It is asked only in the flow that just answered
	// the provider prompt: a stated --provider takes --model or the provider's own default.
	let model = options.model;
	if (provider === "openrouter") {
		const spec = PROVIDER_SPECS.openrouter;
		if (model === null && options.provider === null) {
			const modelQuestion = `\tModel (${spec.defaultModel}): `;
			deps.write(modelQuestion);
			const answer = await deps.ask(modelQuestion, false);
			const typed = answer.value.trim();
			model = typed === "" ? spec.defaultModel : typed;
			if (answer.echoed && typed === "") deps.write(`\x1b[1A\r${modelQuestion}${model}\n`);
			answerLine(modelQuestion, model ?? "", answer.echoed);
		} else {
			model = model ?? spec.defaultModel;
			emit(`\tModel (${spec.defaultModel}): ${model}`);
		}
	}

	const keyAnswer = options.keyOnStdin ? { value: deps.readStdin().split("\n")[0].trim(), echoed: false } : await (async () => {
		deps.write("\tAPI key: ");
		return deps.ask("\tAPI key: ", true);
	})();
	const key = keyAnswer.value.trim();
	if (key === "") throw new CliError("PROVIDER_KEY_REQUIRED", "A provider API key is required. Pipe one in or answer the prompt.");
	if (options.keyOnStdin) emit(`\tAPI key: ${"*".repeat(key.length)}`);
	else answerLine("\tAPI key: ", "*".repeat(key.length), keyAnswer.echoed);
	deps.keychain.set(PROVIDER, provider);
	deps.keychain.set(PROVIDER_KEY, key);
	if (model !== null) deps.keychain.set(PROVIDER_MODEL, model);
	emit("\tStored in your OS keychain. Acquit servers never receive this key.");
	emit(`Operator profile ready: acquit.dev/o/${onboarding.handle}`);
	emit(`Bid credits: ${onboarding.credits?.available ?? 0} (weekly allowance)`);
	return lines.join("\n");
}
