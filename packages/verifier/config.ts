// The verifier's configuration boundary. One module owns every name the service, the API, and a lane
// read, so a missing or malformed one refuses by name at startup instead of waiting on a request.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClientRepository } from "../core/src/github.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const VERIFIER_NAMES = {
	ciUrl: "ACQUIT_VERIFIER_CI_URL",
	runSecret: "ACQUIT_VERIFIER_RUN_SECRET",
	callbackSecret: "ACQUIT_VERIFIER_CALLBACK_SECRET",
	callbackUrl: "ACQUIT_VERIFIER_CALLBACK_URL",
	port: "ACQUIT_VERIFIER_PORT",
	concurrency: "ACQUIT_VERIFIER_CONCURRENCY",
	runDeadlineMs: "ACQUIT_VERIFIER_RUN_DEADLINE_MS",
	clientRepository: "ACQUIT_CLIENT_REPOSITORY",
	hiddenCases: "ACQUIT_HIDDEN_CASES",
} as const;
export type VerifierKey = keyof typeof VERIFIER_NAMES;

export class VerifierConfigError extends Error {
	readonly code: "VERIFIER_CONFIG_MISSING" | "VERIFIER_CONFIG_INVALID";
	/** Environment names, never values. */
	readonly names: readonly string[];
	constructor(code: "VERIFIER_CONFIG_MISSING" | "VERIFIER_CONFIG_INVALID", names: readonly string[], detail: string) {
		super(`${code === "VERIFIER_CONFIG_MISSING" ? "Missing configuration" : "Invalid configuration"}: ${names.join(", ")}. ${detail}`);
		this.name = "VerifierConfigError";
		this.code = code;
		this.names = names;
	}
}

export function verifierValue(key: VerifierKey, env: NodeJS.ProcessEnv = process.env): string {
	return env[VERIFIER_NAMES[key]]?.trim() ?? "";
}

/** Refuses by the environment name, never by a value. Returns the names it was asked for, so callers never re-read. */
export function requireVerifier<T extends VerifierKey>(keys: readonly T[], env: NodeJS.ProcessEnv = process.env): Record<T, string> {
	const missing = keys.filter(key => verifierValue(key, env) === "");
	if (missing.length) throw new VerifierConfigError("VERIFIER_CONFIG_MISSING", missing.map(key => VERIFIER_NAMES[key]), "Set them before starting the process.");
	return Object.fromEntries(keys.map(key => [key, verifierValue(key, env)])) as Record<T, string>;
}

/** The API's view: with no CI URL there is no verifier, and the callback route says so by name. With one, both secrets must exist. */
export function apiVerifierEnv(env: NodeJS.ProcessEnv = process.env): { readonly ciUrl: string; readonly runSecret: string; readonly callbackSecret: string } {
	const ciUrl = verifierValue("ciUrl", env);
	if (!ciUrl) return { ciUrl: "", runSecret: "", callbackSecret: "" };
	return { ciUrl, ...requireVerifier(["runSecret", "callbackSecret"], env) };
}

export type VerifierServiceConfig = {
	readonly port: number;
	readonly runSecret: string;
	readonly callbackSecret: string;
	readonly callbackUrl: string;
	/** Bounded concurrency: a queue, not an unbounded fan-out on an 8 GB box. */
	readonly concurrency: number;
	/** How long a run may wait for a slot before it is refused by name. */
	readonly runDeadlineMs: number;
};

export function serviceConfig(env: NodeJS.ProcessEnv = process.env): VerifierServiceConfig {
	const values = requireVerifier(["runSecret", "callbackSecret", "callbackUrl", "port"], env);
	const port = Number(values.port);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new VerifierConfigError("VERIFIER_CONFIG_INVALID", [VERIFIER_NAMES.port], "Give a port between 1 and 65535.");
	}
	let callback: URL;
	try { callback = new URL(values.callbackUrl); }
	catch { throw new VerifierConfigError("VERIFIER_CONFIG_INVALID", [VERIFIER_NAMES.callbackUrl], "Give an http or https URL the API answers on."); }
	if (callback.protocol !== "http:" && callback.protocol !== "https:") {
		throw new VerifierConfigError("VERIFIER_CONFIG_INVALID", [VERIFIER_NAMES.callbackUrl], "Give an http or https URL the API answers on.");
	}
	const concurrency = optionalCount("concurrency", 2, 1, 8);
	const runDeadlineMs = optionalCount("runDeadlineMs", 120_000, 1_000, 3_600_000);
	return { port, runSecret: values.runSecret, callbackSecret: values.callbackSecret, callbackUrl: callback.toString(), concurrency, runDeadlineMs };
	function optionalCount(key: "concurrency" | "runDeadlineMs", fallback: number, minimum: number, maximum: number): number {
		const raw = verifierValue(key, env);
		if (raw === "") return fallback;
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
			throw new VerifierConfigError("VERIFIER_CONFIG_INVALID", [VERIFIER_NAMES[key]], `Give a whole number between ${minimum} and ${maximum}.`);
		}
		return value;
	}
}

/** The App names the service reads, the same four the API reads. Empty names select the fail-fast port. */
export function githubAppEnv(env: NodeJS.ProcessEnv = process.env): { readonly appId: string; readonly privateKey: string; readonly organization: string; readonly apiBase?: string } {
	return { appId: env.ACQUIT_GITHUB_APP_ID?.trim() ?? "", privateKey: env.ACQUIT_GITHUB_APP_PRIVATE_KEY?.trim() ?? "",
		organization: env.ACQUIT_GITHUB_APP_ORG?.trim() ?? "", apiBase: env.ACQUIT_GITHUB_API_BASE?.trim() };
}

/** The API reads the client repository here; the verifier service reads it from the contract it is handed. */
export function clientRepositoryEnv(env: NodeJS.ProcessEnv = process.env): string {
	return parseClientRepository(verifierValue("clientRepository", env));
}
