// Where the model provider key lives: the OS credential store, never a file, a log line, or argv.
//
//   Windows -> Windows Credential Manager, through the PasswordVault API in PowerShell. The secret
//              arrives on the script's stdin, so it never enters the process table.
//   Linux   -> the kernel user keyring through keyctl. The key is born in the session keyring, where
//              the process that creates it is the possessor and can widen the permissions, and is
//              then linked into the user keyring. The user keyring is memory only and is lost on
//              reboot, so `acquit operator init` is re-run after a reboot; the tutorial's printed
//              text cannot say that, so it lives here.
//   macOS   -> the login keychain through `security add-generic-password`, again from stdin.
//
// Every implementation takes its process runner as a parameter, so a test can prove the secret never
// lands in argv. Tests use memoryKeychain; the commands accept a keychain, never build one themselves.

import { spawnSync } from "node:child_process";
import { CliError } from "./client.ts";

/** The two entries an initialized operator holds: which provider, and its key. */
export const PROVIDER = "acquit:provider";
export const PROVIDER_KEY = "acquit:provider-key";

/**
 * The Linux key permission mask: possessor all; user read, write, search, link — the minimal mask
 * with those four capabilities, verified live on this kernel (`keyctl pipe` works from a later
 * process). View and setattr stay out: search and pipe need neither, and nothing may widen it again.
 */
const LINUX_PERMISSION = "0x3f1e0000";

export type Keychain = {
	set(service: string, secret: string): void;
	get(service: string): string | null;
};

export type KeychainResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
export type KeychainRun = (command: string, args: readonly string[], input: string) => KeychainResult;

const run: KeychainRun = (command, args, input) => {
	const result = spawnSync(command, [...args], { input, encoding: "utf8", timeout: 15_000, windowsHide: true });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function failed(what: string, result: KeychainResult, secret?: string): CliError {
	// A tool can echo back what it was handed; the key never appears in an error this CLI raises.
	const echoed = result.stderr.trim().replace(/\s+/g, " ");
	const detail = (secret ? echoed.split(secret).join("[redacted]") : echoed).slice(0, 200);
	return new CliError("KEYCHAIN_FAILED", `${what} failed. The provider key was not stored.${detail ? ` ${detail}` : ""}`);
}

/**
 * Linux: the kernel user keyring. `padd` reads the secret from stdin; `pipe` reads it back.
 *
 * A fresh key gets possessor-all, user-view. A later process did not create it and does not possess
 * keys linked in @u (that keyring is not in its keyring tree), so it gets only the user bits and
 * `pipe` is denied. Widening those bits takes setattr, and setattr comes with possession; so the key
 * is created in the session keyring @s, which this process possesses, re-permissioned there, linked
 * into @u where it outlives the session, and unlinked from @s again.
 */
export function linuxKeychain(call: KeychainRun = run): Keychain {
	const replace = (keyring: string, service: string): void => {
		const found = call("keyctl", ["search", keyring, "user", service], "");
		const serial = found.stdout.trim();
		if (found.status === 0 && /^\d+$/.test(serial)) call("keyctl", ["unlink", serial, keyring], "");
	};
	return {
		set(service, secret) {
			// A leftover from an interrupted run can sit in either keyring: drop it wherever found.
			replace("@u", service);
			replace("@s", service);
			const added = call("keyctl", ["padd", "user", service, "@s"], secret);
			const serial = added.stdout.trim();
			if (added.status !== 0 || !/^\d+$/.test(serial)) throw failed(`keyctl padd ${service}`, added, secret);
			const permitted = call("keyctl", ["setperm", serial, LINUX_PERMISSION], "");
			if (permitted.status !== 0) throw failed(`keyctl setperm ${service}`, permitted, secret);
			const linked = call("keyctl", ["link", serial, "@u"], "");
			if (linked.status !== 0) throw failed(`keyctl link ${service}`, linked, secret);
			call("keyctl", ["unlink", serial, "@s"], "");
		},
		get(service) {
			const found = call("keyctl", ["search", "@u", "user", service], "");
			const serial = found.stdout.trim();
			if (found.status !== 0 || !/^\d+$/.test(serial)) return null;
			const read = call("keyctl", ["pipe", serial], "");
			return read.status === 0 ? read.stdout : null;
		},
	};
}

/** macOS: the login keychain. `-w` without a value reads the secret from stdin, never from argv. */
export function macKeychain(call: KeychainRun = run): Keychain {
	const account = "acquit";
	return {
		set(service, secret) {
			const added = call("security", ["add-generic-password", "-U", "-a", account, "-s", service, "-w"], secret);
			if (added.status !== 0) throw failed(`security add-generic-password ${service}`, added, secret);
		},
		get(service) {
			const found = call("security", ["find-generic-password", "-a", account, "-s", service, "-w"], "");
			return found.status === 0 ? found.stdout.replace(/\n$/, "") : null;
		},
	};
}

/**
 * Windows: Windows Credential Manager through the WinRT PasswordVault. The PowerShell script carries
 * the service name and the account, never the secret; the secret is read from the script's stdin.
 */
export function windowsKeychain(call: KeychainRun = run): Keychain {
	const account = "acquit";
	const guarded = (service: string): string => {
		if (!/^[A-Za-z0-9:._-]+$/.test(service)) throw new CliError("KEYCHAIN_FAILED", "Invalid keychain entry name.");
		return service;
	};
	return {
		set(service, secret) {
			const name = guarded(service);
			const script = `$ErrorActionPreference='Stop'; `
				+ `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; `
				+ `$secret=[Console]::In.ReadToEnd().TrimEnd([char]13,[char]10); `
				+ `$vault=[Windows.Security.Credentials.PasswordVault]::new(); `
				+ `$credential=[Windows.Security.Credentials.PasswordCredential]::new('${account}','${name}',$secret); `
				+ `try { $vault.Remove($vault.Retrieve('${account}','${name}')) } catch {}; `
				+ `$vault.Add($credential)`;
			const added = call("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], secret);
			if (added.status !== 0) throw failed(`Windows Credential Manager ${name}`, added, secret);
		},
		get(service) {
			const name = guarded(service);
			const script = `$ErrorActionPreference='Stop'; `
				+ `[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; `
				+ `$vault=[Windows.Security.Credentials.PasswordVault]::new(); `
				+ `[Console]::Out.Write($vault.Retrieve('${account}','${name}').Password)`;
			const found = call("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], "");
			return found.status === 0 ? found.stdout : null;
		},
	};
}

/** The store this OS offers. */
export function platformKeychain(platform: NodeJS.Platform = process.platform, call: KeychainRun = run): Keychain {
	if (platform === "win32") return windowsKeychain(call);
	if (platform === "darwin") return macKeychain(call);
	return linuxKeychain(call);
}

/** The seam the runner's `run.ts` consumes: the model provider key, or null when none is stored. */
export type ProviderKeyPort = { getProviderKey(): Promise<string | null> };

/** Wires the OS keychain behind the runner's provider-key port; the root passes this to `run.ts`. */
export function providerKeyPort(keychain: Keychain): ProviderKeyPort {
	return { async getProviderKey() { return keychain.get(PROVIDER_KEY); } };
}

/** The in-memory store the unit tests inject. Nothing here touches a disk or a process. */
export function memoryKeychain(seed: Record<string, string> = {}): Keychain {
	const values = new Map(Object.entries(seed));
	return { set: (service, secret) => { values.set(service, secret); }, get: service => values.get(service) ?? null };
}
