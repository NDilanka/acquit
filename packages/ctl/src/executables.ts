import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const resolved = new Map<string, string | null>();
// libuv searches cwd before PATH on Windows even when cwd is absent from PATH.
// Resolve once ourselves; empty/relative PATH entries and cwd are never trusted.
export function pathExecutable(name: string): string | null {
	if (resolved.has(name)) return resolved.get(name)!;
	const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
	const cwd = resolve(process.cwd()).toLowerCase();
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		const dir = entry.replace(/^"|"$/g, "");
		if (!isAbsolute(dir) || resolve(dir).toLowerCase() === cwd) continue;
		for (const extension of extensions) {
			const path = join(dir, name + extension);
			if (existsSync(path) && statSync(path).isFile()) { resolved.set(name, path); return path; }
		}
	}
	resolved.set(name, null);
	return null;
}
export function windowsExecutable(name: "powershell.exe" | "taskkill.exe"): string {
	const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	if (!root || !isAbsolute(root)) throw new Error("An absolute SystemRoot is required.");
	return name === "powershell.exe" ? join(root, "System32", "WindowsPowerShell", "v1.0", name) : join(root, "System32", name);
}
export function helperEnvironment(): NodeJS.ProcessEnv {
	// Allowlist, not a secret-name denylist. Helpers need no app/browser config.
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
	return env;
}
export function powershellExecutables(): string[] {
	return [...new Set([pathExecutable("pwsh"), windowsExecutable("powershell.exe")].filter((path): path is string => Boolean(path)))];
}
export function browserExecutable(): string {
	const path = pathExecutable("agent-browser");
	if (!path) throw Object.assign(new Error("agent-browser was not found on PATH excluding cwd."), { code: "ENOENT" });
	return path;
}
