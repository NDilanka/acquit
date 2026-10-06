import { ownedProcess, powershell } from "./process.ts";
import { windowsExecutable } from "./executables.ts";
import type { RunState } from "./state.ts";

export interface ThreadObservation { state: string; reason: string }
export function allThreadsSuspended(threads: ThreadObservation[]): boolean {
	return threads.length > 0 && threads.every(thread => thread.state === "Wait" && thread.reason === "Suspended");
}
export async function suspendedRecovery(run: RunState | null, cwd: string) {
	const warning = "Read-only candidates, NOT ownership proof. Independently confirm the PID, creation time and lane before running any manual recovery command. This report never kills.";
	const empty = { checked: true, candidates: [], warning };
	if (!run) return empty;
	if (process.platform !== "win32") return { ...empty, checked: false, reason: "Suspended-thread inspection is Windows-only." };
	const records = (["api", "web"] as const).flatMap(role => {
		const service = run[role];
		return /^[0-9a-f]{32}$/.test(service.nonce ?? "") ? [{ role, service }] : [];
	});
	if (!records.length) return empty;
	try {
		// Inspect argv in the helper but never return it. A nonce is a search
		// hint only: candidates require manual confirmation, never auto-kill.
		const nonces = records.map(record => `"${record.service.nonce}"`).join(",");
		const script = `$ErrorActionPreference="Stop"; $nonces=@(${nonces}); $rows=@(foreach($r in Get-CimInstance Win32_Process) { foreach($nonce in $nonces) { if($r.CommandLine -and $r.CommandLine.Contains($nonce)) { try { $p=Get-Process -Id $r.ProcessId -ErrorAction Stop; $threads=@(foreach($t in $p.Threads) { $state=$t.ThreadState.ToString(); $reason=""; if($state -eq "Wait") { $reason=$t.WaitReason.ToString() }; @{state=$state;reason=$reason} }); @{pid=[int]$r.ProcessId;nonce=$nonce;createdAt=$r.CreationDate.ToString("o");threads=$threads} } catch { throw } } } }); ConvertTo-Json -Depth 5 -Compress -InputObject $rows`;
		const result = await powershell(["-Command", script], cwd);
		const rows: { pid: number; nonce: string; createdAt: string; threads: ThreadObservation[] }[] = JSON.parse(result.stdout);
		if (!Array.isArray(rows)) throw new Error("Invalid inspection response.");
		const candidates = [];
		for (const { role, service } of records) {
			const matches = rows.filter(row => row.nonce === service.nonce && Number.isSafeInteger(row.pid) && row.pid > 0
				&& Array.isArray(row.threads) && allThreadsSuspended(row.threads));
			if (!matches.length || (service.pid > 0 && await ownedProcess(service.pid, service.nonce!, service.socketPath))) continue;
			for (const row of matches) candidates.push({
				role, pid: row.pid, recordedPid: service.pid, nonce: service.nonce, createdAt: row.createdAt,
				allThreadsSuspended: true, ownershipProven: false,
				manualRecoveryCommand: `& '${windowsExecutable("taskkill.exe").replaceAll("'", "''")}' /pid ${row.pid} /t /f`,
			});
		}
		return { checked: true, candidates, warning };
	} catch { return { ...empty, checked: false, reason: "Suspended-process inspection failed; absence is unverified." }; }
}
