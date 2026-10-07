#!/usr/bin/env node
// The in-container runner. It starts the one command the CLI assembled and does nothing else: no
// network policy, no credential handling, no repository logic. The sandbox around it is the CLI's
// job, and the command it starts is the operator's agent.
//
//   node /runner/run.mjs --exec <command> [args...]
//
// stdio is inherited so the agent's own lines stream to the operator's terminal.

import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--exec");
const command = separator === -1 ? null : process.argv[separator + 1];
if (!command) {
	console.error("usage: node /runner/run.mjs --exec <command> [args...]");
	process.exit(2);
}

const child = spawn(command, process.argv.slice(separator + 2), {
	cwd: process.env.ACQUIT_WORKDIR ?? "/work",
	stdio: "inherit",
	env: process.env,
});
child.on("error", error => {
	console.error(`runner: could not start ${command}: ${error.message}`);
	process.exit(127);
});
child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
