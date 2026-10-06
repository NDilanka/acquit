param([Parameter(Mandatory=$true)][string]$Nonce)
$ErrorActionPreference = 'Stop'
if ($Nonce -notmatch '^[0-9a-f]{32}$') { exit 1 }
# Verify the kernel peer ON THE SAME CONNECTION that answers the challenge.
# This runs at stop only, never on the startup/performance readiness path.
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AcquitPipePeer {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
}
'@
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', "acquit-$Nonce", [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
try {
    $pipe.Connect(1000)
    [uint32]$peer = 0
    if (-not [AcquitPipePeer]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$peer)) { exit 1 }
    $request = [Text.Encoding]::ASCII.GetBytes("prove`n")
    $pipe.Write($request, 0, $request.Length)
    $bytes = [byte[]]::new(256)
    $count = 0
    $deadline = [DateTime]::UtcNow.AddSeconds(1)
    while ($count -lt $bytes.Length) {
        $read = $pipe.ReadAsync($bytes, $count, $bytes.Length - $count)
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $read.Wait($remaining)) { exit 1 }
        $size = $read.Result
        if ($size -eq 0) { break }
        $count += $size
        if ($bytes[$count - 1] -eq 10) { break }
    }
    $answer = [Text.Encoding]::ASCII.GetString($bytes, 0, $count)
    if ($answer -notmatch '^([0-9]+) ([0-9]+)\r?\n$') { exit 1 }
    # No command lines, environment values or diagnostics leave this helper.
    "$peer $($Matches[1])"
} catch { exit 1 }
finally { $pipe.Dispose() }
