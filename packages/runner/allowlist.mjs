// The one egress allowlist the runner's proxy reads. A host alone is not enough: the right host on
// another port is still egress the sandbox was never meant to have, so CONNECT is 443 only and a
// plain HTTP forward is 80 or 443.

export const ALLOWED_HOSTS = new Set(["registry.npmjs.org", "api.anthropic.com"]);

/** Exact host names only: a suffix match would let a lookalike through. */
export function allowedHost(host) {
	return ALLOWED_HOSTS.has(String(host ?? "").toLowerCase().replace(/\.$/, ""));
}

/** A CONNECT authority: `host:port`, `host`, `[v6]:port`, or `[v6]`. Null when it is not one. */
export function parseAuthority(authority) {
	const text = String(authority ?? "");
	if (text === "") return null;
	if (text.startsWith("[")) {
		const end = text.indexOf("]");
		if (end === -1) return null;
		const host = text.slice(1, end);
		const rest = text.slice(end + 1);
		if (host === "") return null;
		if (rest === "") return { host, port: 443 };
		if (!rest.startsWith(":")) return null;
		const port = Number(rest.slice(1));
		return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
	}
	const colon = text.lastIndexOf(":");
	if (colon === -1) return { host: text, port: 443 };
	const host = text.slice(0, colon);
	const port = Number(text.slice(colon + 1));
	if (host === "" || !Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
	return { host, port };
}

/** CONNECT only to 443. */
export function allowedConnect(authority) {
	const target = parseAuthority(authority);
	return target !== null && target.port === 443 && allowedHost(target.host);
}

/** A plain HTTP forward only to 80 or 443. */
export function allowedForward(host, port) {
	return (port === 80 || port === 443) && allowedHost(host);
}
