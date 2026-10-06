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
import { dirname, join, resolve } from "node:path";
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
	/** The container hit its memory cap. The submission's own doing, so a verdict fault, not a kill. */
	| "MEMORY_LIMIT"
	/**
	 * An abnormal exit the judge did not cause, and the daemon could not report how the subject
	 * ended. The submission cannot stop the daemon, so the run names the kill instead of reading the
	 * exit code as the submission's own end.
	 */
	| "SUBJECT_KILL_UNREPORTED"
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
	/** The signal that stopped the subject from outside the run; null when the run decided its own end. */
	readonly killedBy: string | null;
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
			const name = containerName();
			// The client writes the container's id here at start. The postmortem filters the daemon's
			// events by that id when it is there, so an event from another container can never match.
			const cidFile = join(dirname(staged.path), "container.cid");
			// One second of slack so a start event cannot fall on the wrong side of the since boundary.
			const since = new Date(Date.now() - 1_000).toISOString();
			try {
				return await spawnSubject({ variant: "DOCKER", command: "docker", args: dockerArgs(treeDir, image, name, staged.path, cidFile),
					cwd: treeDir, calls, deadlineMs,
					remove: () => removeContainer(name),
					postmortem: () => containerPostmortem(name, cidFile, since) });
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
	try {
		chmodSync(work.path, 0o755);
		const path = join(work.path, "bootstrap.ts");
		writeFileSync(path, readFileSync(source));
		chmodSync(path, 0o444);
		return { path, remove: work.remove };
	} catch (error) {
		work.remove();
		throw error;
	}
}

/** The container mounts the submitted tree and this one bootstrap file. The judge package is never inside. */
export function dockerArgs(treeDir: string, image: string, name: string, bootstrap = BOOTSTRAP_PATH,
	cidFile: string | null = null): readonly string[] {
	return ["run", "--rm", "--name", name, ...(cidFile === null ? [] : ["--cidfile", cidFile]),
		"--network", "none", "-i", "--pull=never", "--read-only", "--cap-drop=ALL",
		"--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1", "--user=65534:65534",
		"--mount", `type=bind,${mountSource("tree", treeDir)},target=/tree,readonly`,
		"--mount", `type=bind,${mountSource("bootstrap", bootstrap)},target=/runner/bootstrap.ts,readonly`,
		"--workdir=/tree", image, "node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=256",
		"--v8-pool-size=1", "/runner/bootstrap.ts", "/tree"];
}

/** One name per run, so the launcher can filter the daemon's events by it and remove the container by it. */
function containerName(): string {
	return `acquit-subject-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/** `--rm` covers every exit the container makes itself; this covers a client the judge stopped with the container still up. */
function removeContainer(name: string): void {
	spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 10_000 });
}

/** How long after the close the daemon's event window stays open: the live daemon logs a kill 300-800 ms late. */
const EVENT_LAG_MS = 2_000;
/** Bounded so a missing or wedged daemon can never hold a request open; comfortably above the window. */
const EVENT_QUERY_TIMEOUT_MS = 5_000;

/**
 * What became of a container whose client exited abnormally, when the judge did not stop the client
 * itself. The exit code cannot answer it: an external `docker kill` and a submission's own
 * `process.exit(137)` both leave `docker run` with 137, and the node process inside cannot be told
 * apart by code. The daemon's events can: a kill signal logs `kill`, and the memory cap logs `oom`.
 * Only an abnormal exit reaches here, and the events outlive the container `--rm` removes.
 *
 * The query names the container by the id the client wrote when it is there, so no other container's
 * event can match, and by the run's unique name otherwise. `--until` closes EVENT_LAG_MS after the
 * close instead of at it, because a kill logged late would otherwise fall outside the window; the
 * command blocks until that bound, well inside EVENT_QUERY_TIMEOUT_MS. A query that fails says so:
 * `reported` false is a daemon that could not answer, never a daemon that answered "no kill".
 */
function containerPostmortem(name: string, cidFile: string, since: string): { readonly killedBy: string | null; readonly oom: boolean; readonly reported: boolean } {
	const until = new Date(Date.now() + EVENT_LAG_MS).toISOString();
	const result = spawnSync("docker", ["events", "--filter", `container=${containerFilter(name, cidFile)}`, "--since", since, "--until", until,
		"--format", "{{.Action}}|{{.Actor.Attributes.signal}}"], { encoding: "utf8", timeout: EVENT_QUERY_TIMEOUT_MS });
	if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return { killedBy: null, oom: false, reported: false };
	const lines = result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
	const kill = lines.find(line => line.startsWith("kill|"));
	if (kill !== undefined) return { killedBy: signalName(kill.slice("kill|".length)), oom: false, reported: true };
	return { killedBy: null, oom: lines.some(line => line.startsWith("oom|")), reported: true };
}

/** The container id the client wrote at start, or the run's unique name when the file is absent or malformed. */
function containerFilter(name: string, cidFile: string): string {
	try {
		const id = readFileSync(cidFile, "utf8").trim();
		return /^[0-9a-f]{12,64}$/i.test(id) ? id : name;
	} catch {
		return name;
	}
}

/** A Docker kill event's signal, named for the failure detail. */
function signalName(signal: string): string {
	const names: Record<string, string> = { "2": "SIGINT", "3": "SIGQUIT", "9": "SIGKILL", "15": "SIGTERM" };
	return names[signal] ?? (signal ? `SIG${signal}` : "an external signal");
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
	/** The launcher's own cleanup for a client that died by signal: its work may outlive it. */
	readonly remove?: () => void;
	/** Asked after an abnormal exit the judge did not cause; absent for launchers whose command dies with its work. */
	readonly postmortem?: () => { readonly killedBy: string | null; readonly oom: boolean; readonly reported: boolean };
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
		let judgeKilled = false;
		const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
		/** A kill the judge sends is the judge's own step (its deadline or a limit), never an external kill. */
		const stop = (): void => { judgeKilled = true; child.kill("SIGKILL"); };
		const finish = (exitCode: number | null, signal: string | null, killedBy: string | null): void => {
			clearTimeout(timer);
			// `--rm` covers every exit the container makes itself. A client that died by a signal, and one
			// the judge stopped, may leave the container running: remove it by name in both cases. The
			// judge's own kill can report as exit 137 with no signal, so the signal alone is not the rule.
			if (signal !== null || judgeKilled) plan.remove?.();
			if (buffered.length) faults.add("UNTERMINATED_FRAME");
			resolveRun({ variant: plan.variant, nonce, ready, stdout, stderr, exitCode, signal, killedBy, faults: [...faults], wallMs: performance.now() - started });
		};
		const timer = setTimeout(() => { faults.add("TIMEOUT"); stop(); }, plan.deadlineMs);
		child.on("error", error => { faults.add("SPAWN_ERROR"); stderr += String(error.message); finish(null, null, null); });
		child.stdin.on("error", () => faults.add("STDIN_ERROR"));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > SUBJECT_STDOUT_BYTES) { faults.add("STDOUT_LIMIT"); stop(); return; }
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
			if (Buffer.byteLength(buffered) > SUBJECT_FRAME_BYTES) { faults.add("FRAME_LIMIT"); stop(); }
		});
		child.stderr.on("data", (chunk: string) => {
			if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > SUBJECT_STDERR_BYTES) { faults.add("STDERR_LIMIT"); stop(); return; }
			stderr += chunk;
		});
		child.on("close", (code, signal) => {
			// A signal the judge did not send came from outside the run. In child mode the submitted
			// code can signal itself too; that is the dev-only path, and it reports as external as well,
			// because with the same user and no container there is nothing that could tell them apart.
			let killedBy: string | null = signal !== null && !judgeKilled ? signal : null;
			let oom = false;
			if (plan.postmortem !== undefined && killedBy === null && !judgeKilled && code !== 0) {
				const found = plan.postmortem();
				killedBy = found.killedBy;
				oom = found.oom;
				// A daemon that could not answer has not said "no kill". The submission cannot stop the
				// daemon, so the run names the kill and returns the attempt slot instead of reading the
				// exit code as the submission's own end.
				if (!found.reported) faults.add("SUBJECT_KILL_UNREPORTED");
			}
			if (code !== 0) faults.add("SUBJECT_EXIT");
			if (oom) faults.add("MEMORY_LIMIT");
			if (!ready || answered.size < sent) faults.add("SUBJECT_INCOMPLETE");
			finish(code, signal, killedBy);
		});
		child.stdin.write(JSON.stringify({ kind: "load", nonce, modules: [...new Set(plan.calls.map(call => call.target.module))] }) + "\n");
	});
}
