import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { powershell } from "./process.ts";

export async function browserListenerPorts(ownDaemonPid: number, cwd: string): Promise<number[]> {
	if (!Number.isSafeInteger(ownDaemonPid) || ownDaemonPid < 0) throw new Error("Invalid browser daemon PID.");
	// Native dashboard workers do not include "dashboard" in their argv.
	// Any other agent-browser listener is unsafe, regardless of argv/namespace.
	// Both enumerations must succeed: failure is not evidence of absence.
	const script = `$ErrorActionPreference="Stop"; $ids=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq "agent-browser.exe" -and $_.ProcessId -ne ${ownDaemonPid} } | ForEach-Object ProcessId); $ports=@(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $ids } | ForEach-Object LocalPort); ConvertTo-Json -Compress -InputObject $ports`;
	const result = await powershell(["-Command", script], cwd);
	const ports: unknown = JSON.parse(result.stdout);
	if (!Array.isArray(ports) || !ports.every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535)) throw new Error("Could not verify dashboard absence; approval refused.");
	return ports;
}
export async function dashboardPorts(session: string, cwd: string): Promise<number[]> {
	if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("Invalid browser session.");
	const path = join(homedir(), ".agent-browser", "namespaces", session, "run", `${session}.pid`);
	let pid = 0;
	try {
		const text = (await readFile(path, "utf8")).trim();
		if (!/^[1-9]\d*$/.test(text)) throw new Error("Invalid session daemon PID; approval refused.");
		pid = Number(text);
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return browserListenerPorts(pid, cwd);
}
