// `acquit agent create <name> --prompt <file>`. The prompt stays on this machine: the API receives
// its digest and the tool list, never the text.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CliError, apiFlag, readLogin, resolveToken } from "./client.ts";
import type { ApiClient } from "./client.ts";

export type AgentCreateOptions = {
	readonly apiUrl: string;
	readonly token: string;
	readonly name: string;
	readonly runner: "claude-code" | "codex";
	readonly promptPath: string;
	readonly tools: readonly string[];
};

const USAGE = "Usage: acquit agent create <name> --prompt <file> [--runner claude-code|codex] [--allow-tools Read,Edit,Bash] [--api <url>]";

export function parseAgentArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): AgentCreateOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	if (rest[0] !== "create") throw new CliError("USAGE", USAGE);
	let name: string | null = null;
	let runner: "claude-code" | "codex" = "claude-code";
	let promptPath: string | null = null;
	let tools: string[] = [];
	for (let index = 1; index < rest.length; index++) {
		const flag = rest[index];
		const value = (): string => {
			const next = rest[++index];
			if (next === undefined) throw new CliError("USAGE", `${flag} needs a value.`);
			return next;
		};
		if (flag === "--runner") {
			const next = value();
			if (next !== "claude-code" && next !== "codex") throw new CliError("USAGE", "--runner takes claude-code or codex.");
			runner = next;
		} else if (flag === "--prompt") promptPath = value();
		else if (flag === "--allow-tools") tools = value().split(",").map(tool => tool.trim()).filter(tool => tool !== "");
		else if (flag.startsWith("--")) throw new CliError("USAGE", `Unknown flag ${flag}.`);
		else if (name === null) name = flag;
		else throw new CliError("USAGE", `Unexpected argument ${flag}.`);
	}
	if (name === null || promptPath === null) throw new CliError("USAGE", USAGE);
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new CliError("USAGE", "Agent names are lowercase letters, digits, and dashes.");
	return { apiUrl, token: resolveToken(undefined, env, () => readLogin(env)?.token ?? null), name, runner, promptPath, tools };
}

/** The line count the block prints: the file's lines, with a trailing newline not counting as one. */
function countLines(text: string): number {
	const body = text.replace(/\r?\n$/, "");
	return body.trim() === "" ? 0 : body.split(/\r?\n/).length;
}

export async function runAgentCreate(options: AgentCreateOptions,
	deps: { readonly client: ApiClient; readonly readFile?: (path: string) => string }): Promise<string> {
	const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	let prompt: string;
	try { prompt = read(options.promptPath); }
	catch { throw new CliError("PROMPT_UNREADABLE", `Cannot read the prompt file ${options.promptPath}.`); }
	const lines = countLines(prompt);
	if (lines === 0) throw new CliError("PROMPT_EMPTY", `${options.promptPath} is empty.`);
	const promptDigest = createHash("sha256").update(prompt).digest("hex");
	const answer = await deps.client.post("/api/me/agents", { name: options.name, runner: options.runner, promptDigest, tools: options.tools });
	if (answer.status === 409) throw new CliError("AGENT_EXISTS", `Agent ${options.name} is already registered.`);
	if (answer.status !== 200 && answer.status !== 201) throw new CliError("AGENT_REFUSED", `The API refused the agent (HTTP ${answer.status}).`);
	return [`Agent ${options.name} created`, `\tPrompt: ${options.promptPath} (${lines} lines)`, `\tRunner: ${options.runner}`,
		`\tTools: ${options.tools.length > 0 ? options.tools.join(", ") : "none"}`,
		"\tRuns in: Docker sandbox on this machine"].join("\n");
}
