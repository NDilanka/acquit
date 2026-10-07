// `acquit operator init`: read the merchant status the API already holds, open PayPal onboarding when
// it is still pending, then take the model provider key and store it in the OS keychain. The key is
// read from a prompt or from stdin; it is never written to a file, a log line, argv, or the API.

import { CliError, apiFlag, resolveToken, readLogin } from "./client.ts";
import type { ApiClient } from "./client.ts";
import { PROVIDER, PROVIDER_KEY } from "./keychain.ts";
import type { Keychain } from "./keychain.ts";

export type Provider = "anthropic" | "openai";

export type OperatorInitOptions = {
	readonly apiUrl: string;
	readonly token: string;
	readonly provider: Provider | null;
	readonly keyOnStdin: boolean;
	readonly timeoutSeconds: number;
	readonly pollMs: number;
};

export type OperatorInitDeps = {
	readonly client: ApiClient;
	readonly keychain: Keychain;
	/** Reads one answer. The question is already on stdout, so this only collects the value. */
	readonly ask: (question: string, secret: boolean) => Promise<string>;
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
	// Only the Anthropic key reaches a runner today, so storing an OpenAI one would store a key that
	// nothing can use.
	if (value === "openai") throw new CliError("PROVIDER_UNSUPPORTED", "Only an Anthropic key runs today.");
	if (value === "anthropic") return value;
	throw new CliError("USAGE", "The provider must be anthropic or openai.");
}

export function parseOperatorArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): OperatorInitOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	if (rest[0] !== "init") throw new CliError("USAGE", "Usage: acquit operator init [--provider anthropic|openai] [--provider-key-stdin] [--api <url>]");
	let provider: Provider | null = null;
	let keyOnStdin = false;
	let timeoutSeconds = 600;
	for (let index = 1; index < rest.length; index++) {
		const flag = rest[index];
		if (flag === "--provider" || flag === "--timeout") {
			const next = rest[++index];
			if (next === undefined) throw new CliError("USAGE", `${flag} needs a value.`);
			if (flag === "--provider") provider = providerOf(next);
			else timeoutSeconds = Number(next);
		} else if (flag === "--provider-key-stdin") keyOnStdin = true;
		else throw new CliError("USAGE", `Unknown flag ${flag}.`);
	}
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new CliError("USAGE", "--timeout takes whole seconds.");
	if (keyOnStdin && provider === null) throw new CliError("USAGE", "--provider-key-stdin needs --provider anthropic or --provider openai.");
	return { apiUrl, token: resolveToken(undefined, env, () => readLogin(env)?.token ?? null), provider, keyOnStdin, timeoutSeconds, pollMs: 1_000 };
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

	const question = "\tProvider (anthropic, openai): ";
	// The prompt is already on the terminal; the answer completes the line, and the transcript keeps it whole.
	const answerLine = (prompt: string, answer: string): void => { deps.write(`${answer}\n`); lines.push(`${prompt}${answer}`); };
	let provider = options.provider;
	if (provider === null) {
		deps.write(question);
		const answer = (await deps.ask(question, false)).trim();
		provider = answer === "" ? "anthropic" : providerOf(answer);
		answerLine(question, provider);
	} else emit(`${question}${provider}`);

	const key = options.keyOnStdin ? deps.readStdin().split("\n")[0].trim() : await (async () => {
		deps.write("\tAPI key: ");
		return (await deps.ask("\tAPI key: ", true)).trim();
	})();
	if (key === "") throw new CliError("PROVIDER_KEY_REQUIRED", "A provider API key is required. Pipe one in or answer the prompt.");
	if (options.keyOnStdin) emit(`\tAPI key: ${"*".repeat(key.length)}`);
	else answerLine("\tAPI key: ", "*".repeat(key.length));
	deps.keychain.set(PROVIDER, provider);
	deps.keychain.set(PROVIDER_KEY, key);
	emit("\tStored in your OS keychain. Acquit servers never receive this key.");
	emit(`Operator profile ready: acquit.dev/o/${onboarding.handle}`);
	emit(`Bid credits: ${onboarding.credits?.available ?? 0} (weekly allowance)`);
	return lines.join("\n");
}
