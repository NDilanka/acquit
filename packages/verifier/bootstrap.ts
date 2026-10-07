// The trusted bootstrap the subject process runs. It is the only judge-owned file the Docker
// launcher mounts beside the tree, so the container can never reach the judge package, the hidden
// cases, or the host checkout. It holds no expected value and returns outputs, never a pass.
//
// Order is the guard: it loads the submitted modules first and reports `ready`, and the judge sends
// case inputs only after that. Every frame it writes echoes the run's nonce.

import { createInterface } from "node:readline";
import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FRAME_BYTES = 8_192;
const MAX_CALLS = 256;
const MAX_ERROR_CHARS = 1_024;

/** The frame limits, exported so a test can hold them equal to the judge's own copy. */
export const BOOTSTRAP_LIMITS = { frameBytes: FRAME_BYTES, maxCalls: MAX_CALLS, maxErrorChars: MAX_ERROR_CHARS };

type LoadFrame = { readonly kind: "load"; readonly nonce: string; readonly modules: readonly string[] };
type CallFrame = { readonly kind: "call"; readonly nonce: string; readonly id: string;
	readonly target: { readonly module: string; readonly export: string }; readonly args: readonly unknown[] };

export async function subjectMain(root: string | undefined = process.argv[2]): Promise<number> {
	const parse = JSON.parse.bind(JSON);
	const encode = JSON.stringify.bind(JSON);
	const write = process.stdout.write.bind(process.stdout);
	if (!root) return 2;
	const base = realpathSync(root);
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const lines = input[Symbol.asyncIterator]();
	const first = await lines.next();
	if (first.done) return 2;
	let load: LoadFrame;
	try {
		const frame = parse(String(first.value)) as LoadFrame;
		if (!frame || frame.kind !== "load" || typeof frame.nonce !== "string" || !Array.isArray(frame.modules)
			|| !frame.modules.every(name => typeof name === "string")) throw new Error("Malformed load frame");
		load = frame;
	} catch { return 2; }
	const nonce = load.nonce;
	const modules = new Map<string, Record<string, unknown>>();
	/** A module is imported from inside the tree, with links dereferenced. Nothing else is reachable. */
	const importTarget = async (name: string): Promise<Record<string, unknown>> => {
		const cached = modules.get(name);
		if (cached) return cached;
		const target = resolve(base, name);
		if (!target.startsWith(base + sep)) throw new Error("Target escapes tree");
		if (lstatSync(target).isSymbolicLink()) throw new Error("Symlinked module refused");
		const real = realpathSync(target);
		if (!real.startsWith(base + sep)) throw new Error("Target escapes tree");
		const module = await import(pathToFileURL(real).href) as Record<string, unknown>;
		modules.set(name, module);
		return module;
	};
	for (const name of load.modules) {
		// A module that cannot load is reported by the call that needs it, so every case still gets a reply.
		try { await importTarget(name); } catch { /* reported per call */ }
	}
	write(encode({ kind: "ready", nonce }) + "\n");
	let count = 0;
	for await (const line of lines) {
		if (++count > MAX_CALLS || Buffer.byteLength(line) > FRAME_BYTES) return 2;
		let call: CallFrame | null = null;
		try {
			const frame = parse(line) as CallFrame;
			if (!frame || frame.kind !== "call" || frame.nonce !== nonce || typeof frame.id !== "string" || !Array.isArray(frame.args)
				|| Object.keys(frame.target ?? {}).sort().join(",") !== "export,module"
				|| typeof frame.target.module !== "string" || typeof frame.target.export !== "string") throw new Error("Malformed SubjectCall");
			call = frame;
			const module = await importTarget(frame.target.module);
			if (typeof module[frame.target.export] !== "function") throw new Error("Export is not callable");
			const value = await (module[frame.target.export] as (...args: readonly unknown[]) => unknown)(...frame.args);
			const encoded = encode({ kind: "reply", nonce, id: frame.id, ok: true, value });
			if (Buffer.byteLength(encoded) > FRAME_BYTES) throw new Error("Reply too large");
			write(encoded + "\n");
		} catch (error) {
			write(encode({ kind: "reply", nonce, id: call?.id ?? "", ok: false, error: message(error) }) + "\n");
		}
	}
	return 0;
}

/** One line, capped. The judge keeps it in the raw transcript for diagnosis and never copies it into a verdict. */
export function message(error: unknown): string {
	return String(error).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_ERROR_CHARS);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	// No top-level await: a call that never resolves must die at the judge's deadline as TIMEOUT,
	// not end the process early with node's unsettled-await exit code.
	void subjectMain().then(code => { process.exitCode = code; },
		error => { process.stderr.write(String(error)); process.exitCode = 1; });
}
