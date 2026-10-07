// The operator CLI. F3 owns `submit`; F5 adds login, operator init, agent create, jobs list, bid, run,
// diff, and receipts.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertSubjectAllowed, ChildSubjectRefused, verifierSubjectEnv } from "../../verifier/subject.ts";
import { apiClient, CliError, readLogin, saveLogin } from "./client.ts";
import { localHead, parseSubmitArgs, pushHead, runSubmit } from "./submit.ts";
import { openBrowser, parseLoginArgs, runLogin } from "./login.ts";
import { parseOperatorArgs, runOperatorInit } from "./operator.ts";
import { platformKeychain, providerKeyPort } from "./keychain.ts";
import { parseRunArgs, runRun } from "./run.ts";
import { parseAgentArgs, runAgentCreate } from "./agent.ts";
import { parseJobsArgs, runJobsList } from "./jobs.ts";
import { parseBidArgs, runBid } from "./bid.ts";
import { parseDiffArgs, runDiff } from "./diff.ts";
import { parseReceiptsArgs, runReceipts } from "./receipts.ts";

const USAGE_HEADER = `acquit — work the job board from a terminal

Usage:`;

const USAGE_FOOTER = `
  --token reads the session token from stdin, so it never appears in the process table.
  The token \`acquit login\` receives is stored under your user profile with mode 0600.

Environment:
  ACQUIT_API    API origin (default http://127.0.0.1:4310)
  ACQUIT_TOKEN  session token from \`acquit login\``;

/** The table's order. */
const ORDER = ["login", "operator", "agent", "jobs", "bid", "run", "diff", "receipts", "submit"];

export type CommandContext = {
	readonly env: NodeJS.ProcessEnv;
	readonly write: (text: string) => void;
};

export type Command = {
	readonly name: string;
	readonly usage: string;
	readonly run: (argv: readonly string[], context: CommandContext) => Promise<number>;
};

const commands = new Map<string, Command>();

export function registerCommand(command: Command): void {
	commands.set(command.name, command);
}

/** The usage the terminal prints: only the commands this build actually carries. */
export function usage(): string {
	const lines = ORDER.filter(name => commands.has(name)).map(name => `  ${commands.get(name)!.usage}`);
	return `${USAGE_HEADER}\n${lines.join("\n")}\n${USAGE_FOOTER}`;
}

const stored = (env: NodeJS.ProcessEnv) => () => readLogin(env);

registerCommand({
	name: "submit",
	usage: "acquit submit <job> [--dir .] [--remote <url>] [--api <url>] [--token] [--timeout <seconds>]",
	async run(argv, context) {
		// The unit-test subject is never the product path, whatever this command was asked to do.
		assertSubjectAllowed(verifierSubjectEnv(context.env));
		const options = parseSubmitArgs(argv, context.env, undefined, stored(context.env));
		const client = apiClient({ baseUrl: options.apiUrl, token: options.token });
		console.log(await runSubmit(options, { client, head: localHead, push: pushHead }));
		return 0;
	},
});

registerCommand({
	name: "login",
	usage: "acquit login [--api <url>] [--no-open] [--timeout <seconds>]",
	async run(argv, context) {
		const options = parseLoginArgs(argv, context.env);
		console.log(await runLogin(options, { open: openBrowser, save: login => { saveLogin(login, context.env); } }));
		return 0;
	},
});

registerCommand({
	name: "operator",
	usage: "acquit operator init [--provider anthropic] [--provider-key-stdin] [--api <url>]",
	async run(argv, context) {
		const options = parseOperatorArgs(argv, context.env);
		const client = apiClient({ baseUrl: options.apiUrl, token: options.token });
		await runOperatorInit(options, { client, keychain: platformKeychain(), ask: askQuestion, readStdin: readStdin,
			open: openBrowser, write: context.write });
		return 0;
	},
});

registerCommand({
	name: "agent",
	usage: "acquit agent create <name> --prompt <file> [--runner claude-code|codex] [--allow-tools Read,Edit,Bash] [--api <url>]",
	async run(argv, context) {
		const options = parseAgentArgs(argv, context.env);
		const client = apiClient({ baseUrl: options.apiUrl, token: options.token });
		console.log(await runAgentCreate(options, { client }));
		return 0;
	},
});

registerCommand({
	name: "jobs",
	usage: "acquit jobs list [--api <url>]",
	async run(argv, context) {
		const options = parseJobsArgs(argv, context.env);
		console.log(await runJobsList(options, { client: apiClient({ baseUrl: options.apiUrl, token: options.token }) }));
		return 0;
	},
});

registerCommand({
	name: "bid",
	usage: "acquit bid <job> --price <usd> --eta <days|hours> --agent <name> --pitch <text> [--api <url>]",
	async run(argv, context) {
		const options = parseBidArgs(argv, context.env);
		console.log(await runBid(options, { client: apiClient({ baseUrl: options.apiUrl, token: options.token }) }));
		return 0;
	},
});

registerCommand({
	name: "diff",
	usage: "acquit diff <job> [--dir .] [--api <url>]",
	async run(argv, context) {
		const options = parseDiffArgs(argv, context.env);
		const patch = await runDiff(options, { client: apiClient({ baseUrl: options.apiUrl, token: options.token }) });
		if (patch !== "") console.log(patch);
		return 0;
	},
});

registerCommand({
	name: "receipts",
	usage: "acquit receipts [--api <url>]",
	async run(argv, context) {
		const options = parseReceiptsArgs(argv, context.env);
		console.log(await runReceipts(options, { client: apiClient({ baseUrl: options.apiUrl, token: options.token }) }));
		return 0;
	},
});

registerCommand({
	name: "run",
	usage: "acquit run <job> [--instruction \"...\"] [--runner claude-code|command] [--command <script>] [--dir <path>] [--api <url>] [--token]",
	async run(argv, context) {
		const options = parseRunArgs(argv, context.env, undefined, stored(context.env));
		await runRun(options, { client: apiClient({ baseUrl: options.apiUrl, token: options.token }),
			providerKey: providerKeyPort(platformKeychain()) });
		return 0;
	},
});

/** Reads one line from stdin. The question is already on stdout; this only collects the value. */
function readLine(): Promise<string> {
	return new Promise(resolve => {
		let line = "";
		const finish = (value: string): void => { process.stdin.off("data", onData); process.stdin.pause(); resolve(value); };
		const onData = (chunk: Buffer | string): void => {
			line += String(chunk);
			const end = line.indexOf("\n");
			if (end !== -1) finish(line.slice(0, end).replace(/\r$/, ""));
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", onData);
		process.stdin.once("end", () => finish(line.replace(/\r?\n$/, "")));
		process.stdin.resume();
	});
}

/** Reads one line with the terminal's echo off, so a provider key never appears on the screen. */
function readHiddenLine(): Promise<string> {
	return new Promise(resolve => {
		const stdin = process.stdin;
		let value = "";
		const finish = (): void => { stdin.setRawMode(false); stdin.off("data", onData); stdin.pause(); resolve(value); };
		const onData = (chunk: Buffer | string): void => {
			for (const character of String(chunk)) {
				if (character === "\r" || character === "\n") { finish(); return; }
				if (character === "\u0003") { stdin.setRawMode(false); process.exit(130); }
				if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
				else value += character;
			}
		};
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
	});
}

async function askQuestion(_question: string, secret: boolean): Promise<string> {
	if (!secret || !process.stdin.isTTY) return readLine();
	return readHiddenLine();
}

/** The whole of stdin, for `--provider-key-stdin`. The value never enters argv. */
function readStdin(): string {
	try { return readFileSync(0, "utf8"); } catch { return ""; }
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "-h" || command === "help") { console.log(usage()); return command ? 0 : 2; }
	const registered = commands.get(command);
	if (!registered) { console.error(`acquit: unknown command ${command}\n\n${usage()}`); return 2; }
	if (rest[0] === "--help" || rest[0] === "-h") { console.log(`${registered.usage}\n\n${usage()}`); return 0; }
	try {
		return await registered.run(rest, { env, write: text => process.stdout.write(text) });
	} catch (error) {
		// Every refusal this command can raise prints its own name on one line. A stack is for a bug.
		const refusal = error instanceof CliError || error instanceof ChildSubjectRefused ? error : null;
		if (!refusal) throw error;
		console.error(`acquit: ${refusal.code}: ${refusal.message}`);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2));
}
