// The operator CLI speaks JSON to the API and nothing else. It holds no database handle, no judge,
// and no key: every action is one authenticated HTTP call whose answer the API has already decided.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class CliError extends Error {
	readonly code: string;
	constructor(code: string, detail: string) { super(detail); this.code = code; }
}

export type ApiOptions = {
	readonly baseUrl: string;
	readonly token: string;
	readonly fetch?: typeof globalThis.fetch;
};

export type ApiClient = {
	readonly baseUrl: string;
	get(path: string): Promise<unknown>;
	post(path: string, payload: unknown): Promise<{ status: number; body: unknown }>;
};

export function apiClient(options: ApiOptions): ApiClient {
	const base = new URL(options.baseUrl);
	const call = options.fetch ?? globalThis.fetch;
	const headers = (): Record<string, string> => ({ "content-type": "application/json",
		cookie: `acquit_session=${options.token}`, "x-acquit-cli": "1" });
	return {
		baseUrl: base.origin,
		async get(path) {
			const response = await reach(call, new URL(path, base), { headers: headers() }, base);
			const body = await response.json().catch(() => null);
			if (!response.ok) throw refusal(response.status, body);
			return body;
		},
		async post(path, payload) {
			const response = await reach(call, new URL(path, base), { method: "POST", headers: headers(), body: JSON.stringify(payload) }, base);
			const body = await response.json().catch(() => null);
			if (!response.ok && response.status !== 409) throw refusal(response.status, body);
			return { status: response.status, body };
		},
	};
}

/** A fetch rejection is a connection problem, not a stack: the origin is named, the detail is bounded. */
async function reach(call: typeof globalThis.fetch, url: URL, init: RequestInit, base: URL): Promise<Response> {
	try { return await call(url, init); }
	catch (error) {
		const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200);
		throw new CliError("API_UNREACHABLE", `The Acquit API at ${base.origin} could not be reached.${detail ? ` ${detail}` : ""}`);
	}
}

function refusal(status: number, body: unknown): CliError {
	const error = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
		? String((body as Record<string, unknown>).error) : "HTTP_ERROR";
	const detail = body && typeof body === "object" && typeof (body as Record<string, unknown>).detail === "string"
		? String((body as Record<string, unknown>).detail) : `The API answered ${status}.`;
	return new CliError(error, detail);
}

/** The session token never appears in an error message or a log line. */
export function resolveToken(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env,
	stored: () => string | null = () => null): string {
	const token = explicit ?? env.ACQUIT_TOKEN ?? stored();
	if (!token) throw new CliError("AUTH_REQUIRED", "No session token. Run `acquit login`, set ACQUIT_TOKEN, or pipe it to `acquit submit <job> --token`.");
	return token;
}

export const DEFAULT_API = "http://127.0.0.1:4310";

/** What `acquit login` stores: the origin it signed in to and the session token it received. */
export type StoredLogin = {
	readonly api: string;
	readonly token: string;
	readonly handle: string;
	readonly role: string;
};

/**
 * The login file lives under the user profile: `%APPDATA%\acquit\cli.json` on Windows and
 * `$XDG_CONFIG_HOME/acquit/cli.json` (or `~/.config/acquit/cli.json`) elsewhere. ACQUIT_CLI_CONFIG
 * names the file directly, which is how the tests keep a machine's real profile out of the suite.
 */
export function loginConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.ACQUIT_CLI_CONFIG) return env.ACQUIT_CLI_CONFIG;
	if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "acquit", "cli.json");
	return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "acquit", "cli.json");
}

/** Writes the token with mode 0600, replacing a file whose mode a previous run may have widened. */
export function saveLogin(login: StoredLogin, env: NodeJS.ProcessEnv = process.env): string {
	const path = loginConfigPath(env);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

/** The stored login, or null when there is none or the file is not the shape this build wrote. */
export function readLogin(env: NodeJS.ProcessEnv = process.env): StoredLogin | null {
	try {
		const parsed = JSON.parse(readFileSync(loginConfigPath(env), "utf8")) as Record<string, unknown>;
		const values = ["api", "token", "handle", "role"].map(key => parsed[key]);
		if (values.some(value => typeof value !== "string" || value === "")) return null;
		return { api: values[0] as string, token: values[1] as string, handle: values[2] as string, role: values[3] as string };
	} catch { return null; }
}

/** The API origin a command talks to: the flag, then ACQUIT_API, then the origin `acquit login` stored. */
export function resolveApi(flag: string | null, env: NodeJS.ProcessEnv = process.env): string {
	return flag ?? env.ACQUIT_API ?? readLogin(env)?.api ?? DEFAULT_API;
}

/** One `--api <url>` flag, shared by the commands whose only common flag it is. */
export function apiFlag(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): { readonly apiUrl: string; readonly rest: readonly string[] } {
	let apiUrl: string | null = null;
	const rest: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--api") {
			const next = argv[++index];
			if (next === undefined) throw new CliError("USAGE", "--api needs a value.");
			apiUrl = next;
		} else rest.push(flag);
	}
	return { apiUrl: resolveApi(apiUrl, env), rest };
}
