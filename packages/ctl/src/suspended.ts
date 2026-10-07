import { ownedService, powershell } from "./process.ts";
import { resolve } from "node:path";
import type { RunState } from "./state.ts";

export interface ThreadObservation { state: string; reason: string }
export function allThreadsSuspended(threads: ThreadObservation[]): boolean {
	return threads.length > 0 && threads.every(thread => thread.state === "Wait" && thread.reason === "Suspended");
}
export async function suspendedRecovery(run: RunState | null, cwd: string) {
	const warning = "Read-only candidates, NOT ownership proof. Independently confirm ownership before any manual recovery. No kill command is provided: a reported PID can be reused. This report never kills.";
	const empty = { checked: true, candidates: [], warning };
	if (!run) return empty;
	if (process.platform !== "win32") return { ...empty, checked: false, reason: "Suspended-thread inspection is Windows-only." };
	const records = (["api", "web", "verifier"] as const).flatMap(role => {
		const service = run[role];
		return service && /^[0-9a-f]{32}$/.test(service.nonce ?? "") ? [{ role, service }] : [];
	});
	if (!records.length) return empty;
	try {
		// Parse Windows argv; a nonce substring or argument after the script's
		// separator is not a preload option. Never return arbitrary command lines.
		const nonces = records.map(record => `"${record.service.nonce}"`).join(",");
		const preload = resolve(cwd, "packages/ctl/src/ownership-preload.cjs").replaceAll("'", "''");
		const script = `$ErrorActionPreference="Stop";
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AcquitArgv { [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count); [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p); public static string[] Parse(string command) { int count; var p=CommandLineToArgvW(command,out count); if(p==IntPtr.Zero) throw new Exception("argv parse failed"); try { var args=new string[count]; for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return args; } finally { LocalFree(p); } } }';
$nonces=@(${nonces}); $preload='${preload}';
$rows=@(foreach($r in Get-CimInstance Win32_Process) {
 if($r.Name -ine "node.exe" -or -not $r.CommandLine) { continue }
 $argv=[AcquitArgv]::Parse($r.CommandLine); $separator=[Array]::IndexOf($argv,"--"); $hasPreload=$false;
 for($i=1;$i -lt $separator-1;$i++) { if($argv[$i] -ceq "--require" -and $argv[$i+1] -ieq $preload) { $hasPreload=$true } }
 if(-not $hasPreload -or $separator -ne $argv.Length-2 -or $argv[-1] -cnotin $nonces) { continue }
 $p=Get-Process -Id $r.ProcessId -ErrorAction Stop;
 $threads=@(foreach($t in $p.Threads) { $state=$t.ThreadState.ToString(); $reason=""; if($state -eq "Wait") { $reason=$t.WaitReason.ToString() }; @{state=$state;reason=$reason} });
 @{pid=[int]$r.ProcessId;nonce=$argv[-1];createdAt=$r.CreationDate.ToString("o");threads=$threads}
}); ConvertTo-Json -Depth 5 -Compress -InputObject $rows`;
		const result = await powershell(["-Command", script], cwd);
		const rows: { pid: number; nonce: string; createdAt: string; threads: ThreadObservation[] }[] = JSON.parse(result.stdout);
		if (!Array.isArray(rows)) throw new Error("Invalid inspection response.");
		const candidates = [];
		for (const { role, service } of records) {
			const matches = rows.filter(row => row.nonce === service.nonce && Number.isSafeInteger(row.pid) && row.pid > 0
				&& Array.isArray(row.threads) && allThreadsSuspended(row.threads));
			if (!matches.length) continue;
			const provenPid = service.pid > 0 && await ownedService(service) ? service.pid : null;
			for (const row of matches.filter(row => row.pid !== provenPid)) candidates.push({
				role, pid: row.pid, recordedPid: service.pid, nonce: service.nonce, createdAt: row.createdAt,
				allThreadsSuspended: true, ownershipProven: false,
			});
		}
		return { checked: true, candidates, warning };
	} catch { return { ...empty, checked: false, reason: "Suspended-process inspection failed; absence is unverified." }; }
}
