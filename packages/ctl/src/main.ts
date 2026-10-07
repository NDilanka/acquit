#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CliError } from "./process.ts";
import { flags, help, registry } from "./registry.ts";
import { context } from "./state.ts";
import type { Parsed } from "./registry.ts";

function closest(input: string, names: string[]): string {
	const distance = (a: string, b: string) => {
		let row = Array.from({ length: b.length + 1 }, (_, i) => i);
		for (let i = 0; i < a.length; i++) {
			const next = [i + 1];
			for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
			row = next;
		}
		return row[b.length];
	};
	return names.find(name => name.startsWith(input)) ?? names.toSorted((a, b) => distance(input, a) - distance(input, b))[0];
}
const args = process.argv.slice(2);
const name = args[0] ?? "";
if (name === "clock" && args[1] === "advance" && args[2] && !args[2].startsWith("--")) args.splice(1, 2, "--duration", args[2]);
if (name === "fund-mode" && args[1] && !args[1].startsWith("--")) args.splice(1, 1, "--mode", args[1]);
try {
	if (args.length === 0 || (args.length === 1 && name === "--help")) {
		process.stdout.write(help());
	} else {
		const command = registry.find(entry => entry.name === name);
		if (!command) throw new CliError("UNKNOWN_COMMAND", `Unknown command ${JSON.stringify(name)}.`, `Try npm run -s ctl -- ${closest(name, registry.map(entry => entry.name))}, or npm run -s ctl -- --help.`, 2);
		const specs = flags(command);
		let parsed: Parsed;
		try {
			parsed = parseArgs({ args: args.slice(1), strict: true, allowPositionals: false,
				options: Object.fromEntries(specs.map(flag => [flag.name, { type: flag.type, ...(flag.default !== undefined ? { default: flag.default } : {}) }])) }).values;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid arguments.";
			const unknown = message.match(/Unknown option ['"]--([^'"]+)/)?.[1];
			throw new CliError(unknown ? "UNKNOWN_FLAG" : "INVALID_ARGUMENT", message,
				unknown ? `Try --${closest(unknown, specs.map(flag => flag.name))}, or npm run -s ctl -- ${name} --help.` : `Run npm run -s ctl -- ${name} --help and use the documented flags.`, 2);
		}
		if (parsed.help) process.stdout.write(help(command));
		else {
			for (const flag of specs) if (flag.required && (typeof parsed[flag.name] !== "string" || !String(parsed[flag.name]).trim())) {
				throw new CliError("MISSING_ARGUMENT", `--${flag.name} is required.`, `Run npm run -s ctl -- ${command.examples[0]}. See npm run -s ctl -- ${name} --help.`, 2);
			}
			const data = await command.run(parsed, context());
			process.stdout.write(command.name === "ledger" && !parsed.json ? String(data.text) : JSON.stringify({ ok: true, command: name, ...(parsed["dry-run"] ? { dryRun: true } : {}), data }) + "\n");
		}
	}
} catch (error) {
	const failure = error instanceof CliError ? error : new CliError("IO_FAILED", "The CLI could not complete the operation. No sensitive diagnostics were forwarded.", "Check repository file permissions and dependencies, then run npm run -s ctl -- status.");
	process.stdout.write(JSON.stringify({ ok: false, command: name, error: { code: failure.code, message: failure.message, fix: failure.fix } }) + "\n");
	process.exitCode = failure.exitCode;
}
