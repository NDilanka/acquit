// Runs the physical checker as a child process. The checker sees the public spec, the delivery, and the sealed checks, so
// it runs with a reduced environment, a hard deadline, and an output cap. Every fault is a fixed code: the checker's own
// stderr and error text can quote a sealed point, so neither ever reaches a verdict.

import { spawn } from "node:child_process";

export type CheckerInput = { readonly spec: unknown; readonly artefact: string; readonly checks: readonly unknown[] };

/** The judge's reading of one checker run: the public rules in the order asked for, and the checks in the order sent. */
export type CheckerRun =
	/** The checker refused the delivery at parse: it is not a readable drawing. */
	| { readonly kind: "refused" }
	| { readonly kind: "checked"; readonly rules: readonly boolean[]; readonly checks: readonly boolean[] }
	/** The checker did not answer: it crashed, timed out, ran past its output cap, or answered something malformed. */
	| { readonly kind: "fault"; readonly detail: string };

export const CHECKER_DEADLINE_MS = 60_000;
const CHECKER_OUTPUT_BYTES = 65_536;

/** Runs one checker entry with the input on stdin and reads its one-line JSON reply. */
export function runChecker(entry: string, input: CheckerInput, publicRules: readonly string[], deadlineMs = CHECKER_DEADLINE_MS): Promise<CheckerRun> {
	return new Promise(resolveRun => {
		let stdout = "";
		let settled = false;
		const finish = (run: CheckerRun): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveRun(run);
		};
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], { env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "ignore"] });
		const stop = (detail: string): void => {
			finish({ kind: "fault", detail });
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop("CHECKER_TIMEOUT"), deadlineMs);
		child.stdin.on("error", () => undefined);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout) > CHECKER_OUTPUT_BYTES) stop("CHECKER_OUTPUT_LIMIT");
		});
		child.on("error", () => finish({ kind: "fault", detail: "CHECKER_SPAWN_FAILED" }));
		child.on("close", (code, signal) => {
			if (code !== 0 || signal !== null) return finish({ kind: "fault", detail: "CHECKER_CRASHED" });
			finish(replyOf(stdout, publicRules, input.checks.length));
		});
		child.stdin.end(JSON.stringify(input));
	});
}

/** A reply the checker wrote, read against the rule names and the check count the judge sent. Anything else is a fault. */
function replyOf(text: string, publicRules: readonly string[], checkCount: number): CheckerRun {
	const malformed: CheckerRun = { kind: "fault", detail: "CHECKER_REPLY_MALFORMED" };
	let reply: unknown;
	try {
		reply = JSON.parse(text.trim()) as unknown;
	} catch {
		return malformed;
	}
	if (!isRecord(reply)) return malformed;
	if (reply.kind === "refused") return { kind: "refused" };
	if (reply.kind === "malformed") return { kind: "fault", detail: "CHECKER_INPUT_REJECTED" };
	if (reply.kind !== "checked" || !isRecord(reply.rules) || !Array.isArray(reply.checks)) return malformed;
	const rules = reply.rules;
	if (Object.keys(rules).length !== publicRules.length) return malformed;
	const ruleResults = publicRules.map(rule => rules[rule]);
	if (!ruleResults.every(isBoolean)) return malformed;
	if (reply.checks.length !== checkCount || !reply.checks.every(isBoolean)) return malformed;
	return { kind: "checked", rules: ruleResults, checks: reply.checks };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
