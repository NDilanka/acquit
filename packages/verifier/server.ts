// The verifier service entrypoint. Run it like the API:
//   node packages/verifier/server.ts
// Every name it needs is read at packages/verifier/config.ts, and a missing one refuses by name before
// the process listens. SIGTERM stops accepting runs, lets the in-flight ones finish inside a grace,
// and exits 0.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createGitHubApp, missingGitHubNames } from "../core/src/github.ts";
import { createInstallationTokens } from "./app-token.ts";
import { githubAppEnv, serviceConfig } from "./config.ts";
import { createRunSource } from "./fetch.ts";
import { createVerifierService } from "./service.ts";
import type { VerifierService } from "./service.ts";
import { assertSubjectAllowed, subjectFor, verifierSubjectEnv } from "./subject.ts";

/** The production wiring: the Docker subject (or the child one under ACQUIT_DEV), the real App client, and a GitHub source. */
export function createProductionService(): { readonly service: VerifierService; readonly port: number; readonly subject: string } {
	const config = serviceConfig();
	const selection = verifierSubjectEnv();
	assertSubjectAllowed(selection);
	const github = githubAppEnv();
	const tokens = createInstallationTokens(github);
	return { port: config.port, subject: selection.subject,
		service: createVerifierService({ runSecret: config.runSecret, callback: { url: config.callbackUrl, secret: config.callbackSecret },
			subject: subjectFor(selection), publisher: createGitHubApp(github),
			source: createRunSource({ organization: github.organization ?? "", tokenFor: tokens }),
			runDeadlineMs: config.runDeadlineMs, concurrency: config.concurrency }) };
}

async function main(): Promise<void> {
	const { service, port, subject } = createProductionService();
	const missing = missingGitHubNames(githubAppEnv());
	const server = createServer((request, response) => {
		void route(request, response).catch(() => {
			if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
		});
	});
	async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
		const answer = await service.handle(new Request(`http://127.0.0.1:${port}${request.url ?? "/"}`, { method: request.method,
			headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
			body: Buffer.concat(chunks) }));
		response.writeHead(answer.status, Object.fromEntries(answer.headers));
		response.end(await answer.text());
	}
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
