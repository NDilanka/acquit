// The one egress allowlist the runner's proxy reads. A host alone is not enough: the right host on
// another port is still egress the sandbox was never meant to have, so CONNECT is 443 only and a
// plain HTTP forward is an http URL on port 80 only. An https absolute-form forward is refused rather
// than downgraded or tunneled from the plain path: 443 belongs to CONNECT alone.

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

/** A plain forward only of an absolute-form http URL to an allowlisted host on port 80, with no
 * userinfo: forwarding `user:pass@host` upstream would hand the caller's secret onward. */
export function allowedForward(url) {
	return url.protocol === "http:" && url.username === "" && url.password === ""
		&& (url.port === "" || url.port === "80") && allowedHost(url.hostname);
}

/** Hop-by-hop headers a proxy must not forward. `Connection` adds names to this set. */
const HOP_BY_HOP = new Set(["connection", "proxy-authorization", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The request headers a forward copies upstream. Everything hop-by-hop is dropped, including any
 * header `Connection` names, so a request cannot smuggle one past the proxy's own hop. */
export function forwardHeaders(headers) {
	const drop = new Set(HOP_BY_HOP);
	const connection = headers.connection;
	for (const value of Array.isArray(connection) ? connection : [connection]) {
		if (typeof value !== "string") continue;
		for (const name of value.split(",")) drop.add(name.trim().toLowerCase());
	}
	const kept = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || drop.has(name.toLowerCase())) continue;
		kept[name] = value;
	}
	return kept;
}
