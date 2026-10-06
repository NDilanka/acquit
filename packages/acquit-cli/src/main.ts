// The operator CLI. F3 owns `submit`; the rest of the tutorial's commands land with the runner.

import { pathToFileURL } from "node:url";
import { assertSubjectAllowed, verifierSubjectEnv } from "../../verifier/subject.ts";
import { apiClient, CliError } from "./client.ts";
import { localHead, parseSubmitArgs, pushHead, runSubmit } from "./submit.ts";

const USAGE = `acquit — work the job board from a terminal

Usage:
  acquit submit <job> [--dir .] [--remote <url>] [--api <url>] [--timeout <seconds>]

Environment:
  ACQUIT_API    API origin (default http://127.0.0.1:4310)
  ACQUIT_TOKEN  session token from \`acquit login\``;

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "-h" || command === "help") { console.log(USAGE); return command ? 0 : 2; }
	if (command !== "submit") { console.error(`acquit: unknown command ${command}\n\n${USAGE}`); return 2; }
	try {
		// The unit-test subject is never the product path, whatever this command was asked to do.
		assertSubjectAllowed(verifierSubjectEnv(env));
		const options = parseSubmitArgs(rest, env);
		const client = apiClient({ baseUrl: options.apiUrl, token: options.token });
		console.log(await runSubmit(options, { client, head: localHead, push: pushHead }));
		return 0;
	} catch (error) {
		if (error instanceof CliError) { console.error(`acquit: ${error.code}: ${error.message}`); return 1; }
		throw error;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2));
}
