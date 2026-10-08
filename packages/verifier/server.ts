// The verifier service entrypoint. Run it like the API:
//   node packages/verifier/server.ts
// Every name it needs is read at packages/verifier/config.ts, and a missing one refuses by name before
// the process listens. SIGTERM stops accepting runs, lets the in-flight ones finish inside a grace,
// and exits 0.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createGitHubApp, missingGitHubNames } from "../core/src/github.ts";
import { githubAppEnv, serviceConfig, VerifierConfigError } from "./config.ts";
import { createRunSource } from "./fetch.ts";
import { loadHiddenCases } from "./hidden.ts";
import { createVerifierService, BODY_LIMIT_BYTES } from "./service.ts";
import type { VerifierService } from "./service.ts";
import { assertSubjectAllowed, subjectFor, verifierSubjectEnv } from "./subject.ts";

/** The production wiring: the Docker subject (or the child one under ACQUIT_DEV), the real App client, and a GitHub source. */
export function createProductionService(): { readonly service: VerifierService; readonly port: number; readonly subject: string } {
	const config = serviceConfig();
	const cases = loadHiddenCases();
	const selection = verifierSubjectEnv();
	assertSubjectAllowed(selection);
	const github = githubAppEnv();
	// One client for the publisher and the source's tokens: one boundary, one token cache.
	const app = createGitHubApp(github);
	return { port: config.port, subject: selection.subject,
		service: createVerifierService({ runSecret: config.runSecret, callback: { url: config.callbackUrl, secret: config.callbackSecret },
			subject: subjectFor(selection), publisher: app, cases,
			source: createRunSource({ organization: github.organization ?? "", tokenFor: owner => app.installationToken(owner) }),
			runDeadlineMs: config.runDeadlineMs, concurrency: config.concurrency }) };
}

/** The HTTP shell every lane runs: Node's request in, the service's Response out. */
export function createHttpShell(service: VerifierService, port: number): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		void (async () => {
			// The cap is enforced while reading: a body past it is answered and stopped, never buffered.
			const declared = Number(request.headers["content-length"] ?? "");
			if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) { tooLarge(request, response); return; }
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
				size += buffer.length;
				if (size > BODY_LIMIT_BYTES) { tooLarge(request, response); return; }
				chunks.push(buffer);
			}
			const body = Buffer.concat(chunks);
			// A GET or HEAD carries no body, and Request refuses one.
			const answer = await service.handle(new Request(`http://127.0.0.1:${port}${request.url ?? "/"}`, { method: request.method,
				headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
				...(body.length === 0 ? {} : { body }) }));
			response.writeHead(answer.status, Object.fromEntries(answer.headers));
			response.end(await answer.text());
		})().catch(error => {
			// The message names the fault; it never carries a request body or a secret.
			console.error(`Verifier request failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
		});
	};
}

/** Answers 413 and stops the request once its declared or streamed size passes the cap. */
function tooLarge(request: IncomingMessage, response: ServerResponse): void {
	response.writeHead(413, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
	response.end(JSON.stringify({ error: "RUN_BODY_TOO_LARGE" }));
	response.once("finish", () => request.destroy());
}

async function main(): Promise<void> {
	let built: { readonly service: VerifierService; readonly port: number; readonly subject: string };
	try { built = createProductionService(); }
	catch (error) {
		// A configuration refusal names its code and the environment variable, never a value, and exits before the port is bound.
		if (error instanceof VerifierConfigError) { console.error(`Acquit verifier: ${error.code}: ${error.message}`); process.exit(1); }
		throw error;
	}
	const { service, port, subject } = built;
	const missing = missingGitHubNames(githubAppEnv());
	const server = createServer(createHttpShell(service, port));
	let stopping = false;
	async function stop(): Promise<void> {
		if (stopping) return;
		stopping = true;
		await new Promise<void>(resolve => server.close(() => resolve()));
		await service.close({ graceMs: 15_000 });
		process.exit(0);
	}
	process.on("SIGTERM", () => { void stop(); });
	process.on("SIGINT", () => { void stop(); });
	server.listen(port, "127.0.0.1", () => {
		// Names only: a value never reaches a log line.
		console.log(`Acquit verifier: http://127.0.0.1:${port} (subject ${subject}, github ${missing.length ? `missing ${missing.join(", ")}` : "configured"})`);
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
