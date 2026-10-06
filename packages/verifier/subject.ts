// The subject side. It launches submitted code in its own process and answers raw calls.
// It holds no assertion, no expected value, and it never imports the judge.
//
// Two launchers satisfy the same interface. The child-process one is the unit-test path. The Docker
// one is the product path: no network, a read-only tree, and a credential-free environment. The
// daemon is an operator item, so the Docker launcher probes once and refuses by name when it is down.
//
// The protocol is judge-owned. The launcher writes one `load` frame carrying a per-run nonce, waits
// for the subject's `ready`, and only then writes the case inputs. Stdin stays open until every case
// is answered, so a call that never returns is killed at the deadline instead of ending the process.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { asSubjectFrame, SUBJECT_FRAME_BYTES } from "../core/src/verifier.ts";
import type { SubjectCall } from "../core/src/verifier.ts";

const SUBJECT_STDOUT_BYTES = 262_144;
const SUBJECT_STDERR_BYTES = 65_536;
const DEFAULT_DEADLINE_MS = 10_000;

export class DockerUnavailable extends Error {
	readonly code = "DOCKER_UNAVAILABLE";
	constructor(detail = "The Docker daemon is not reachable.") { super(detail); }
}

/** A comma is the one character that adds a field to a `--mount` value. A path is not a field list. */
export class MountPathUnsafe extends Error {
	readonly code = "MOUNT_PATH_UNSAFE";
	constructor(what: string, path: string) { super(`The ${what} path cannot be a Docker mount source: ${JSON.stringify(path)}`); }
}

/** The unit-test subject is refused outside an explicit test/dev run. It is not a security boundary. */
export class ChildSubjectRefused extends Error {
	readonly code = "SUBJECT_CHILD_REFUSED";
	constructor(detail = "The child-process subject is the unit-test path only. Use the Docker subject, or set ACQUIT_DEV=1 for a test/dev run.") { super(detail); }
}

export type SubjectFault =
	| "SPAWN_ERROR" | "STDIN_ERROR" | "TIMEOUT" | "STDOUT_LIMIT" | "STDERR_LIMIT"
	| "FRAME_LIMIT" | "UNTERMINATED_FRAME" | "SUBJECT_EXIT"
	/** The subject never reported ready, or closed with cases still unanswered. */
	| "SUBJECT_INCOMPLETE"
	/** A frame addressed to this run did not follow the protocol. */
	| "SUBJECT_FRAME_REJECTED";

export type SubjectRun = {
	readonly variant: "CHILD_PROCESS" | "DOCKER";
	/** Every frame of this run must echo it. */
	readonly nonce: string;
	/** The submitted modules were loaded before any case input was written. */
	readonly ready: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly faults: readonly SubjectFault[];
	readonly wallMs: number;
};

export interface SubjectLauncher {
	readonly variant: SubjectRun["variant"];
	run(treeDir: string, calls: readonly SubjectCall[], deadlineMs?: number): Promise<SubjectRun>;
}

/** The launcher a deployment asks for. `ACQUIT_VERIFIER_SUBJECT` names it; `ACQUIT_DEV=1` is the test/dev flag. */
export function verifierSubjectEnv(env: NodeJS.ProcessEnv = process.env): { readonly subject: string; readonly dev: boolean } {
	return { subject: env.ACQUIT_VERIFIER_SUBJECT?.trim() || "docker", dev: env.ACQUIT_DEV === "1" };
}

/** Refuses a selection the deployment may not run, by name. Nothing is launched here. */
export function assertSubjectAllowed(selection: { readonly subject: string; readonly dev: boolean }): void {
	if (selection.subject !== "docker" && selection.subject !== "child") throw new ChildSubjectRefused(`Unknown subject ${selection.subject}. Use docker or child.`);
	if (selection.subject === "child" && selection.dev !== true) throw new ChildSubjectRefused();
}

/** The one place a launcher is chosen. Production config calls it, so the refusal is structural. */
export function subjectFor(selection: { readonly subject: string; readonly dev: boolean }): SubjectLauncher {
	assertSubjectAllowed(selection);
	return selection.subject === "child" ? childProcessSubject() : dockerSubject();
}

/** Runs the subject as a plain child process with a reduced environment. Same-user, so it is the unit path only. */
export function childProcessSubject(): SubjectLauncher {
	return {
		variant: "CHILD_PROCESS",
		async run(treeDir, calls, deadlineMs = DEFAULT_DEADLINE_MS) {
			const entry = fileURLToPath(new URL("./bootstrap.ts", import.meta.url));
			return await spawnSubject({ variant: "CHILD_PROCESS", command: process.execPath,
				args: ["--disable-warning=ExperimentalWarning", "--max-old-space-size=256", "--v8-pool-size=1", entry, treeDir],
				cwd: treeDir, calls, deadlineMs });
		},
	};
}

/** The trusted bootstrap. A run stages its own copy, so the mode of this file on the host never decides a verdict. */
const BOOTSTRAP_PATH = fileURLToPath(new URL("./bootstrap.ts", import.meta.url));

/** The product path. `--network none`, a read-only tree, no capabilities, and no host credentials. */
export function dockerSubject(options: { readonly image?: string; readonly probe?: () => boolean } = {}): SubjectLauncher {
	const image = options.image ?? process.env.VERIFIER_NODE_IMAGE ?? "node:24-bookworm-slim";
	return {
		variant: "DOCKER",
		async run(treeDir, calls, deadlineMs = DEFAULT_DEADLINE_MS) {
			if (!(options.probe ?? dockerReachable)()) throw new DockerUnavailable("The Docker daemon is not running; the subject was not started.");
			const staged = stageBootstrap();
			try {
				return await spawnSubject({ variant: "DOCKER", command: "docker", args: dockerArgs(treeDir, image, staged.path),
					cwd: treeDir, calls, deadlineMs });
			} finally {
				staged.remove();
			}
		},
	};
}

/**
 * Copies the trusted bootstrap into a per-run work directory with explicit modes. The container runs
 * as uid 65534, so a checkout file the runner owns at 0600, or a mkdtemp directory under umask 077,
 * would read as EACCES. Bytes are copied verbatim; only the copy is mounted.
 */
export function stageBootstrap(source = BOOTSTRAP_PATH): { readonly path: string; readonly remove: () => void } {
	const work = subjectWorkDir();
	chmodSync(work.path, 0o755);
	const path = join(work.path, "bootstrap.ts");
	writeFileSync(path, readFileSync(source));
	chmodSync(path, 0o444);
	return { path, remove: work.remove };
}

/** The container mounts the submitted tree and this one bootstrap file. The judge package is never inside. */
export function dockerArgs(treeDir: string, image: string, bootstrap = BOOTSTRAP_PATH): readonly string[] {
	return ["run", "--rm", "--network", "none", "-i", "--pull=never", "--read-only", "--cap-drop=ALL",
		"--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1", "--user=65534:65534",
		"--mount", `type=bind,${mountSource("tree", treeDir)},target=/tree,readonly`,
		"--mount", `type=bind,${mountSource("bootstrap", bootstrap)},target=/runner/bootstrap.ts,readonly`,
		"--workdir=/tree", image, "node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=256",
		"--v8-pool-size=1", "/runner/bootstrap.ts", "/tree"];
}

function mountSource(what: string, path: string): string {
	if (path.includes(",")) throw new MountPathUnsafe(what, path);
	return `source=${path}`;
}

/** Bounded so a missing or wedged daemon can never hold a request open. */
export function dockerReachable(): boolean {
	const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 5_000 });
	return probe.status === 0;
}

export function subjectWorkDir(): { readonly path: string; readonly remove: () => void } {
	const path = mkdtempSync(resolve(tmpdir(), "acquit-subject-"));
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

type SpawnPlan = {
	readonly variant: SubjectRun["variant"];
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly calls: readonly SubjectCall[];
	readonly deadlineMs: number;
};

function spawnSubject(plan: SpawnPlan): Promise<SubjectRun> {
	return new Promise(resolveRun => {
		const started = performance.now();
		const nonce = randomBytes(16).toString("hex");
		const faults = new Set<SubjectFault>();
		const answered = new Set<string>();
		let stdout = "";
		let stderr = "";
		let buffered = "";
		let ready = false;
		let sent = 0;
		const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
		const finish = (exitCode: number | null, signal: string | null): void => {
			clearTimeout(timer);
			if (buffered.length) faults.add("UNTERMINATED_FRAME");
			resolveRun({ variant: plan.variant, nonce, ready, stdout, stderr, exitCode, signal, faults: [...faults], wallMs: performance.now() - started });
		};
		const timer = setTimeout(() => { faults.add("TIMEOUT"); child.kill("SIGKILL"); }, plan.deadlineMs);
		child.on("error", error => { faults.add("SPAWN_ERROR"); stderr += String(error.message); finish(null, null); });
		child.stdin.on("error", () => faults.add("STDIN_ERROR"));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > SUBJECT_STDOUT_BYTES) { faults.add("STDOUT_LIMIT"); child.kill("SIGKILL"); return; }
			stdout += chunk;
			buffered += chunk;
			let end = buffered.indexOf("\n");
			while (end >= 0) {
				const line = buffered.slice(0, end);
				if (Buffer.byteLength(line) > SUBJECT_FRAME_BYTES) faults.add("FRAME_LIMIT");
				const frame = asSubjectFrame(line, nonce);
				if (!ready && frame?.kind === "ready") {
					ready = true;
					sent = plan.calls.length;
					child.stdin.write(plan.calls.map(call => JSON.stringify({ kind: "call", nonce, ...call })).join("\n") + "\n");
					if (sent === 0) child.stdin.end();
				} else if (frame?.kind === "reply" && !answered.has(frame.id)) {
					answered.add(frame.id);
					if (ready && answered.size >= sent) child.stdin.end();
				}
				buffered = buffered.slice(end + 1);
				end = buffered.indexOf("\n");
			}
			if (Buffer.byteLength(buffered) > SUBJECT_FRAME_BYTES) { faults.add("FRAME_LIMIT"); child.kill("SIGKILL"); }
		});
		child.stderr.on("data", (chunk: string) => {
			if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > SUBJECT_STDERR_BYTES) { faults.add("STDERR_LIMIT"); child.kill("SIGKILL"); return; }
			stderr += chunk;
		});
		child.on("close", (code, signal) => {
			if (code !== 0) faults.add("SUBJECT_EXIT");
			if (!ready || answered.size < sent) faults.add("SUBJECT_INCOMPLETE");
			finish(code, signal);
		});
		child.stdin.write(JSON.stringify({ kind: "load", nonce, modules: [...new Set(plan.calls.map(call => call.target.module))] }) + "\n");
	});
}
