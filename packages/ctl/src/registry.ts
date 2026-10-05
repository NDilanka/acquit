import { login, screenshot, seedDb, start, status, stop } from "./commands.ts";
import type { Context } from "./state.ts";

export interface FlagSpec {
	name: string;
	type: "string" | "boolean";
	summary: string;
	default?: string | boolean;
	defaultDescription?: string;
	required?: boolean;
}
export type Parsed = Record<string, string | boolean | undefined>;
export type Result = Record<string, unknown>;
export interface Command {
	name: string;
	summary: string;
	usage: string;
	flags: FlagSpec[];
	examples: string[];
	destructive: boolean;
	run: (parsed: Parsed, ctx: Context) => Promise<Result>;
}
export const registry: Command[] = [
	{ name: "start", summary: "Launch the API and web app, or reuse a healthy owned run.", usage: "start [--timeout <s>]",
		flags: [{ name: "timeout", type: "string", summary: "Readiness timeout in seconds.", default: "30" }],
		examples: ["start", "start --timeout 60"], destructive: false, run: start },
	{ name: "stop", summary: "Stop only the process trees recorded by this CLI.", usage: "stop [--dry-run]",
		flags: [], examples: ["stop --dry-run", "stop"], destructive: true, run: stop },
	{ name: "status", summary: "Read-only doctor for owned processes, ports, database, and key names.", usage: "status",
		flags: [], examples: ["status"], destructive: false, run: status },
	{ name: "seed-db", summary: "Reset demo tables and invalidate all existing sessions.", usage: "seed-db [--dry-run] [--yes]",
		flags: [{ name: "yes", type: "boolean", summary: "Confirm reset while an app is running.", default: false }],
		examples: ["seed-db --dry-run", "seed-db --yes"], destructive: true, run: seedDb },
	{ name: "login", summary: "Create a local development session for a seeded handle.", usage: "login --test-user <handle> [--save]",
		flags: [{ name: "test-user", type: "string", summary: "Development handle from GET /api/users.", required: true },
			{ name: "save", type: "boolean", summary: "Save the local token to data/ctl/sessions/<handle>.json.", default: false }],
		examples: ["login --test-user maya-client --save"], destructive: false, run: login },
	{ name: "screenshot", summary: "Capture the web app in an isolated headless acquit-ctl browser.", usage: "screenshot [--path </route>] [--as <handle>] [--out <file.png>] [--full] [--wait-text <text>]",
		flags: [{ name: "path", type: "string", summary: "Same-origin route to capture.", default: "/" },
			{ name: "as", type: "string", summary: "Development handle to log in as." },
			{ name: "out", type: "string", summary: "Output PNG, relative to repository root.", defaultDescription: "data/evidence/<ISO-stamp>-<slug>.png" },
			{ name: "full", type: "boolean", summary: "Capture the full scroll height.", default: false },
			{ name: "wait-text", type: "string", summary: "Wait for visible text instead of network idle." }],
		examples: ["screenshot --as maya-client --path /", "screenshot --path / --full --wait-text Jobs"], destructive: false, run: screenshot },
];
export function flags(command: Command): FlagSpec[] {
	return [...command.flags, ...(command.destructive ? [{ name: "dry-run", type: "boolean" as const, summary: "Report proposed changes without making them.", default: false }] : []),
		{ name: "help", type: "boolean", summary: "Show help.", default: false }];
}
export function help(command?: Command): string {
	const entries = command ? [command] : registry;
	return [
		command ? `Usage: npm run -s ctl -- ${command.usage}` : "Usage: npm run -s ctl -- <command> [flags]",
		...entries.flatMap(entry => [
			`\n${entry.name}${entry.destructive ? " [destructive]" : ""}  ${entry.summary}`,
			`  ${entry.usage}`,
			...flags(entry).map(flag => `  --${flag.name}${flag.type === "string" ? " <value>" : ""}  ${flag.summary}${flag.required ? " Required." : ""}${flag.defaultDescription !== undefined || flag.default !== undefined ? ` Default: ${flag.defaultDescription ?? flag.default}.` : ""}`),
			"  Examples:", ...entry.examples.map(example => `    npm run -s ctl -- ${example}`),
		]),
		"\nExit codes: 0 success, 1 runtime failure, 2 usage error.",
		'Success: {"ok":true,"command":"...","dryRun":true,"data":{...}} (dryRun only for dry runs).',
		'Failure: {"ok":false,"command":"...","error":{"code":"...","message":"...","fix":"..."}}',
		"Help is the only non-JSON stdout output.",
	].join("\n") + "\n";
}
