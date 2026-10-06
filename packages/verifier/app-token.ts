// Installation tokens for the verifier's git fetch. The App client in core/github.ts keeps its signer
// private and its port exposes no token, so the service mints its own from the same App names. The two
// must always agree on the App configuration; fold this back into the port when it exposes tokenFor.

import { createPrivateKey, createSign } from "node:crypto";
import { GitHubAppError, GitHubAppNotConfigured, missingGitHubNames, parseGitHubAppConfig } from "../core/src/github.ts";
import type { GitHubAppConfigInput } from "../core/src/github.ts";

const REFRESH_MARGIN_MS = 60_000;

export type InstallationTokens = (owner: string) => Promise<string>;

/** One token per owner, refreshed shortly before GitHub expires it. A missing App refuses by name. */
export function createInstallationTokens(config: GitHubAppConfigInput | undefined, call: typeof globalThis.fetch = globalThis.fetch): InstallationTokens {
	const parsed = parseGitHubAppConfig(config);
	if (!parsed) return async () => { throw new GitHubAppNotConfigured(`Missing ${missingGitHubNames(config).join(", ")}.`); };
	const tokens = new Map<string, { readonly token: string; readonly expiresAtMs: number }>();
	const minting = new Map<string, Promise<string>>();
	let installations: Promise<readonly { readonly id: number; readonly account: string }[]> | null = null;

	const appCall = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
		let response: Response;
		let text: string;
		try {
			response = await call(`${parsed.apiBase}${path}`, { method, headers: { accept: "application/vnd.github+json",
				authorization: `Bearer ${appJwt(parsed.appId, parsed.privateKey)}`, "user-agent": `acquit-verifier/${parsed.appId}`,
				...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(parsed.timeoutMs) });
			text = await response.text();
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") throw new GitHubAppError("GITHUB_TIMEOUT", `${method} ${path} timed out after ${parsed.timeoutMs} ms.`);
			throw new GitHubAppError("GITHUB_NETWORK", `${method} ${path} could not reach ${parsed.apiBase}: ${error instanceof Error ? error.message : String(error)}`);
		}
		let parsedBody: unknown = null;
		if (text.trim() !== "") {
			try { parsedBody = JSON.parse(text); }
			catch { throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `${method} ${path} answered ${response.status} with a body that is not JSON.`, { status: response.status }); }
		}
		if (response.status < 200 || response.status >= 300) {
			const said = parsedBody !== null && typeof parsedBody === "object" ? (parsedBody as { message?: unknown }).message : null;
			throw new GitHubAppError("GITHUB_HTTP_ERROR", `${method} ${path} answered ${response.status}${typeof said === "string" ? `: ${said}` : "."}`, { status: response.status });
		}
		return { status: response.status, body: parsedBody };
	};

	const installationsOf = async (): Promise<readonly { readonly id: number; readonly account: string }[]> => {
		installations ??= (async () => {
			const found: { id: number; account: string }[] = [];
			for (let page = 1; page <= 10; page++) {
				const answer = await appCall("GET", `/app/installations?per_page=100&page=${page}`);
				if (!Array.isArray(answer.body)) throw new GitHubAppError("GITHUB_RESPONSE_INVALID", "GET /app/installations answered without a list of installations.");
				for (const item of answer.body) {
					const id = (item as { id?: unknown }).id;
					const account = (item as { account?: { login?: unknown } }).account?.login;
					if (typeof id === "number" && Number.isSafeInteger(id) && typeof account === "string") found.push({ id, account });
				}
				if (answer.body.length < 100) break;
			}
			return found;
		})();
		installations.catch(() => { installations = null; });
		return installations;
	};

	return async owner => {
		const cached = tokens.get(owner);
		if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cached.token;
		const running = minting.get(owner);
		if (running) return running;
		const mint = (async () => {
			const list = await installationsOf();
			const installation = list.find(item => item.account.toLowerCase() === owner.toLowerCase());
			if (installation === undefined) {
				throw new GitHubAppError("GITHUB_INSTALLATION_MISSING", `The App has no installation on ${owner}. Install the App on ${owner} before this call.`);
			}
			const answer = await appCall("POST", `/app/installations/${installation.id}/access_tokens`);
			const token = (answer.body as { token?: unknown }).token;
			if (typeof token !== "string" || token === "") throw new GitHubAppError("GITHUB_RESPONSE_INVALID", `The installation token for ${owner} carried no token.`);
			const expiresAt = Date.parse((answer.body as { expires_at?: unknown }).expires_at as string);
			tokens.set(owner, { token, expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : 0 });
			return token;
		})();
		minting.set(owner, mint);
		try { return await mint; } finally { minting.delete(owner); }
	};
}

/** An RS256 App JWT. `iat` is backdated a minute for clock skew and `exp` stays under GitHub's ten-minute cap. */
function appJwt(appId: string, privateKey: string): string {
	let key;
	try { key = createPrivateKey({ key: privateKey, format: "pem" }); }
	catch { throw new GitHubAppError("GITHUB_APP_KEY_INVALID", "ACQUIT_GITHUB_APP_PRIVATE_KEY does not parse as a PEM private key."); }
	const seconds = Math.floor(Date.now() / 1000);
	const claims = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))}`;
	const signer = createSign("RSA-SHA256");
	signer.update(claims);
	return `${claims}.${signer.sign(key, "base64url")}`;
}

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
