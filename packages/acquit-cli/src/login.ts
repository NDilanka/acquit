// `acquit login`: the CLI asks the API for a one-time code, prints and opens the web URL that carries
// it, waits for a signed-in browser to approve, and stores the session token under the user profile.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { CliError, apiFlag, saveLogin } from "./client.ts";
import type { StoredLogin } from "./client.ts";

export type LoginOptions = {
	readonly apiUrl: string;
	readonly openBrowser: boolean;
	readonly timeoutSeconds: number;
	readonly pollMs: number;
};

export type LoginDeps = {
	readonly fetch?: typeof globalThis.fetch;
	readonly open?: (url: string) => void;
	readonly write?: (line: string) => void;
	readonly save?: (login: StoredLogin) => void;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
};

export function parseLoginArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): LoginOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	let openBrowser = true;
	let timeoutSeconds = 600;
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		if (flag === "--no-open") openBrowser = false;
		else if (flag === "--timeout") {
			const next = rest[++index];
			if (next === undefined) throw new CliError("USAGE", "--timeout needs a value.");
			timeoutSeconds = Number(next);
		} else throw new CliError("USAGE", `Unknown flag ${flag}.`);
	}
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new CliError("USAGE", "--timeout takes whole seconds.");
	return { apiUrl, openBrowser, timeoutSeconds, pollMs: 1_000 };
}

/** The browser opener this OS offers. The URL is printed either way, so a failure here is not fatal. */
export function openBrowser(url: string): void {
	const [command, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url]]
		: process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => {});
		child.unref();
	} catch { /* the URL is already on the terminal */ }
}

type CodeAnswer = { readonly code?: unknown; readonly url?: unknown };
type PollAnswer = { readonly status?: unknown; readonly token?: unknown; readonly user?: { readonly handle?: unknown; readonly role?: unknown }; readonly error?: unknown };

export async function runLogin(options: LoginOptions, deps: LoginDeps = {}): Promise<string> {
	const call = deps.fetch ?? globalThis.fetch;
	const write = deps.write ?? ((line: string) => console.log(line));
	const open = deps.open ?? openBrowser;
	const save = deps.save ?? ((login: StoredLogin) => { saveLogin(login); });
	const sleep = deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
	const now = deps.now ?? Date.now;
	const base = new URL(options.apiUrl);
	// The verifier stays in this process; the API stores only its digest. The code is printed and
	// handed to the browser opener, so anyone who reads the process table sees a code that is useless
	// without the verifier.
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const created = await call(new URL("/api/cli/codes", base), { method: "POST",
		headers: { "content-type": "application/json", "x-acquit-cli": "1" }, body: JSON.stringify({ challenge }) });
	const issued = await created.json().catch(() => null) as CodeAnswer | null;
	const code = typeof issued?.code === "string" ? issued.code : null;
	const url = typeof issued?.url === "string" ? issued.url : null;
	if (!created.ok || code === null || url === null) {
		throw new CliError("LOGIN_FAILED", `The API did not issue a one-time sign-in code (HTTP ${created.status}).`);
	}
	write(`Open ${url} in your browser to approve this sign-in.`);
	if (options.openBrowser) open(url);
	const deadline = now() + options.timeoutSeconds * 1_000;
	for (;;) {
		const polled = await call(new URL(`/api/cli/codes/${encodeURIComponent(code)}`, base),
			{ headers: { "x-acquit-cli": "1", "X-Acquit-Verifier": verifier } });
		const answer = await polled.json().catch(() => null) as PollAnswer | null;
		if (polled.status === 404) throw new CliError("LOGIN_UNKNOWN", "The API does not know this sign-in code. Run `acquit login` again.");
		if (polled.status === 403) throw new CliError("LOGIN_VERIFIER_MISMATCH",
			"The API refused this sign-in code's verifier. Run `acquit login` again.");
		if (polled.status === 410) {
			throw new CliError(answer?.error === "CLI_CODE_USED" ? "LOGIN_USED" : "LOGIN_EXPIRED",
				"This sign-in link is no longer valid. Run `acquit login` again.");
		}
		if (!polled.ok || answer === null) throw new CliError("HTTP_ERROR", `The API answered HTTP ${polled.status} while waiting for approval.`);
		const user = answer.user;
		if (answer.status === "APPROVED" && typeof answer.token === "string" && typeof user?.handle === "string" && typeof user.role === "string") {
			save({ api: base.origin, token: answer.token, handle: user.handle, role: user.role });
			return `Signed in as ${user.handle} (${user.role.toLowerCase()})`;
		}
		if (now() >= deadline) throw new CliError("LOGIN_TIMEOUT", "The sign-in code expired before a browser approved it. Run `acquit login` again.");
		await sleep(options.pollMs);
	}
}
