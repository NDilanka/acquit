// The operator CLI speaks JSON to the API and nothing else. It holds no database handle, no judge,
// and no key: every action is one authenticated HTTP call whose answer the API has already decided.

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
			const response = await call(new URL(path, base), { headers: headers() });
			const body = await response.json().catch(() => null);
			if (!response.ok) throw refusal(response.status, body);
			return body;
		},
		async post(path, payload) {
			const response = await call(new URL(path, base), { method: "POST", headers: headers(), body: JSON.stringify(payload) });
			const body = await response.json().catch(() => null);
			if (!response.ok && response.status !== 409) throw refusal(response.status, body);
			return { status: response.status, body };
		},
	};
}

function refusal(status: number, body: unknown): CliError {
	const error = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
		? String((body as Record<string, unknown>).error) : "HTTP_ERROR";
	const detail = body && typeof body === "object" && typeof (body as Record<string, unknown>).detail === "string"
		? String((body as Record<string, unknown>).detail) : `The API answered ${status}.`;
	return new CliError(error, detail);
}

/** The session token never appears in an error message or a log line. */
export function resolveToken(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
	const token = explicit ?? env.ACQUIT_TOKEN;
	if (!token) throw new CliError("AUTH_REQUIRED", "No session token. Pass --token or set ACQUIT_TOKEN, or run `acquit login`.");
	return token;
}
