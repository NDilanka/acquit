import { isIP } from "node:net";

/**
 * Who may start a demo. `open` admits every address, which is the deployment's state when
 * ACQUIT_DEMO_ALLOW_IPS is unset or empty. A listed set admits only its normalized addresses.
 */
export type DemoAllowlist = { readonly open: true } | { readonly open: false; readonly addresses: ReadonlySet<string> };

/**
 * The address in the one form the allowlist compares: lowercase, IPv6 in canonical form, and an
 * IPv4-mapped IPv6 address (`::ffff:192.0.2.4`) read as the IPv4 address it carries. Null when the text
 * is not an IP address at all, so it can never match a listed entry.
 */
function normalizeAddress(address: string): string | null {
	const text = address.trim().toLowerCase();
	const family = isIP(text);
	if (family === 4) return text;
	if (family !== 6) return null;
	const canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
	if (!mapped) return canonical;
	const high = parseInt(mapped[1]!, 16);
	const low = parseInt(mapped[2]!, 16);
	return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/**
 * The comma-separated ACQUIT_DEMO_ALLOW_IPS value, parsed once. Entries are trimmed and empty ones
 * dropped, so an unset, empty, or separators-only value is open. An entry that is not an IP address
 * refuses the boot by name; the value itself is never echoed.
 */
export function parseDemoAllowlist(raw: string | undefined): DemoAllowlist {
	const entries = (raw ?? "").split(",").map(entry => entry.trim()).filter(entry => entry.length > 0);
	if (entries.length === 0) return { open: true };
	const addresses = new Set<string>();
	for (const entry of entries) {
		const address = normalizeAddress(entry);
		if (address === null) throw new Error("Invalid configuration: ACQUIT_DEMO_ALLOW_IPS lists an entry that is not an IP address.");
		addresses.add(address);
	}
	return { open: false, addresses };
}

/**
 * Whether the public demo is open to this client address. The address is the one the server's
 * client-address logic reads, never a second parse. An address that does not normalize is not listed.
 */
export function demoOpenTo(allowlist: DemoAllowlist, clientAddress: string): boolean {
	if (allowlist.open) return true;
	const address = normalizeAddress(clientAddress);
	return address !== null && allowlist.addresses.has(address);
}
