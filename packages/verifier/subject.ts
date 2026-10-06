// The subject side. It runs submitted code in its own process and answers raw calls.
// It holds no assertion, no expected value, and it never imports the judge.
//
// Two launchers satisfy the same interface. The child-process one is the unit-test path. The Docker
// one is the product path: no network, a read-only tree, and a credential-free environment. The
// daemon is an operator item, so the Docker launcher probes once and refuses by name when it is down.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { SUBJECT_FRAME_BYTES } from "../core/src/verifier.ts";
import type { SubjectCall } from "../core/src/verifier.ts";

const SUBJECT_STDOUT_BYTES = 262_144;
const SUBJECT_STDERR_BYTES = 65_536;
const DEFAULT_DEADLINE_MS = 10_000;
const MAX_CALLS = 256;

export class DockerUnavailable extends Error {
	readonly code = "DOCKER_UNAVAILABLE";
	constructor(detail = "The Docker daemon is not reachable.") { super(detail); }
}

export type SubjectFault =
	| "SPAWN_ERROR" | "STDIN_ERROR" | "TIMEOUT" | "STDOUT_LIMIT" | "STDERR_LIMIT"
	| "FRAME_LIMIT" | "UNTERMINATED_FRAME" | "SUBJECT_EXIT";

export type SubjectRun = {
	readonly variant: "CHILD_PROCESS" | "DOCKER";
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

/** The trusted bootstrap. Captures JSON and stdout before any submitted module is imported. */
export async function subjectMain(root: string | undefined = process.argv[2]): Promise<number> {
	const parse = JSON.parse.bind(JSON);
	const encode = JSON.stringify.bind(JSON);
	const write = process.stdout.write.bind(process.stdout);
	if (!root) return 2;
	const base = resolve(root);
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const modules = new Map<string, Record<string, unknown>>();
	let count = 0;
	for await (const line of input) {
		if (++count > MAX_CALLS || Buffer.byteLength(line) > SUBJECT_FRAME_BYTES) return 2;
		let call: SubjectCall | null = null;
		try {
			const frame = parse(line) as SubjectCall;
			if (!frame || Object.keys(frame).sort().join(",") !== "args,id,target" || typeof frame.id !== "string" || !Array.isArray(frame.args)
				|| Object.keys(frame.target ?? {}).sort().join(",") !== "export,module"
				|| typeof frame.target.module !== "string" || typeof frame.target.export !== "string") throw new Error("Malformed SubjectCall");
			call = frame;
			const path = resolve(base, frame.target.module);
			if (!path.startsWith(base + sep)) throw new Error("Target escapes tree");
			let module = modules.get(path);
			if (!module) {
				module = await import(pathToFileURL(path).href) as Record<string, unknown>;
				modules.set(path, module);
			}
			if (typeof module[frame.target.export] !== "function") throw new Error("Export is not callable");
			const value = await (module[frame.target.export] as (...args: readonly unknown[]) => unknown)(...frame.args);
			const encoded = encode({ id: frame.id, ok: true, value });
			if (Buffer.byteLength(encoded) > SUBJECT_FRAME_BYTES) throw new Error("Reply too large");
			write(encoded + "\n");
		} catch (error) {
			write(encode({ id: call?.id ?? "", ok: false, error: String(error).slice(0, 1_024) }) + "\n");
		}
	}
	return 0;
}

/** Runs the subject as a plain child process with a reduced environment. Same-user, so it is the unit path only. */
export function childProcessSubject(): SubjectLauncher {
	return {
		variant: "CHILD_PROCESS",
		async run(treeDir, calls, deadlineMs = DEFAULT_DEADLINE_MS) {
			const started = performance.now();
			const entry = fileURLToPath(new URL("./subject.ts", import.meta.url));
			return await spawnSubject({ variant: "CHILD_PROCESS", command: process.execPath,
				args: ["--disable-warning=ExperimentalWarning", "--max-old-space-size=256", "--v8-pool-size=1", entry, treeDir],
				cwd: treeDir, calls, deadlineMs, started });
		},
	};
}

/** The product path. `--network none`, a read-only tree, no capabilities, and no host credentials. */
export function dockerSubject(options: { readonly image?: string; readonly probe?: () => boolean } = {}): SubjectLauncher {
	const image = options.image ?? process.env.VERIFIER_NODE_IMAGE ?? "node:24-bookworm-slim";
	return {
		variant: "DOCKER",
		async run(treeDir, calls, deadlineMs = DEFAULT_DEADLINE_MS) {
			if (!(options.probe ?? dockerReachable)()) throw new DockerUnavailable("The Docker daemon is not running; the subject was not started.");
			const started = performance.now();
			return await spawnSubject({ variant: "DOCKER", command: "docker",
				args: ["run", "--rm", "--network", "none", "-i", "--pull=never", "--read-only", "--cap-drop=ALL",
					"--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1", "--user=65534:65534",
					"--mount", `type=bind,source=${treeDir},target=/tree,readonly`,
					"--mount", `type=bind,source=${fileURLToPath(new URL(".", import.meta.url))},target=/runner,readonly`,
					"--workdir=/tree", image, "node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=256",
					"--v8-pool-size=1", "/runner/subject.ts", "/tree"],
				cwd: treeDir, calls, deadlineMs, started });
		},
	};
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
	readonly started: number;
};

function spawnSubject(plan: SpawnPlan): Promise<SubjectRun> {
	return new Promise(resolveRun => {
		const faults = new Set<SubjectFault>();
		let stdout = "";
		let stderr = "";
		let buffered = "";
		const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
		const finish = (exitCode: number | null, signal: string | null): void => {
			clearTimeout(timer);
			if (buffered.length) faults.add("UNTERMINATED_FRAME");
			resolveRun({ variant: plan.variant, stdout, stderr, exitCode, signal, faults: [...faults], wallMs: performance.now() - plan.started });
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
				if (Buffer.byteLength(buffered.slice(0, end)) > SUBJECT_FRAME_BYTES) faults.add("FRAME_LIMIT");
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
			finish(code, signal);
		});
		child.stdin.end(plan.calls.map(call => JSON.stringify(call)).join("\n") + "\n");
	});
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = await subjectMain();
