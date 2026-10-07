// The one egress allowlist a proxy reads. A host alone is not enough: the right host on another port
// is still egress the sandbox was never meant to have, so CONNECT is 443 only and a plain HTTP
// forward is an http URL on port 80 only. An https absolute-form forward is refused rather than
// downgraded or tunneled from the plain path: 443 belongs to CONNECT alone.
//
// The allowed hosts are the package registry plus the one provider host the CLI named in
// ACQUIT_PROVIDER_HOST (the stored provider's host, or Anthropic's when none is stored). The named
// value is checked against the hosts the CLI's provider table can carry; anything else is refused,
// so an environment value can never widen egress beyond known providers.

export const REGISTRY_HOST = "registry.npmjs.org";
/** The provider the sandbox allowed before OpenRouter existed, and the default when none is named. */
export const DEFAULT_PROVIDER_HOST = "api.anthropic.com";

/** The provider hosts the CLI's provider table can name. This file is the copy that runs inside the
 * proxy image, which carries no CLI code, so the two lists move together. */
const PROVIDER_HOSTS = new Set([DEFAULT_PROVIDER_HOST, "openrouter.ai"]);

/** The provider host this proxy allows, from the value the CLI passed. An absent value is the
 * default provider; a value outside the provider table's hosts is refused (null). */
export function providerHost(value) {
	const named = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (named === "") return DEFAULT_PROVIDER_HOST;
	return PROVIDER_HOSTS.has(named) ? named : null;
}

/** The exact hosts one proxy allows: the registry plus its provider host. Null refuses every host,
 * which is what proxy.mjs exits on before it listens. */
export function allowedHosts(value) {
	const provider = providerHost(value);
	return provider === null ? null : new Set([REGISTRY_HOST, provider]);
}

/** Exact host names only: a suffix match would let a lookalike through. */
export function allowedHost(host, hosts) {
	return hosts.has(String(host ?? "").toLowerCase().replace(/\.$/, ""));
}

/** A CONNECT authority: `host:port`, `host`, `[v6]:port`, or `[v6]`. Null when it is not one. A
 * userinfo prefix is not one of those forms, and its text must never be treated as a host. */
export function parseAuthority(authority) {
	const text = String(authority ?? "");
	if (text === "" || text.includes("@")) return null;
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
export function allowedConnect(authority, hosts) {
	const target = parseAuthority(authority);
	return target !== null && target.port === 443 && allowedHost(target.host, hosts);
}

/** The one word a denial log prints for a CONNECT authority: the parsed host and port only. The raw
 * text can carry userinfo, so it is never echoed; anything unparseable reads `<unparseable>`. */
export function authorityLabel(authority) {
	const target = parseAuthority(authority);
	return target === null ? "<unparseable>" : `${target.host}:${target.port}`;
}

/** A plain forward only of an absolute-form http URL to an allowlisted host on port 80, with no
 * userinfo: forwarding `user:pass@host` upstream would hand the caller's secret onward. */
export function allowedForward(url, hosts) {
	return url.protocol === "http:" && url.username === "" && url.password === ""
		&& (url.port === "" || url.port === "80") && allowedHost(url.hostname, hosts);
}

/** Hop-by-hop headers a proxy must not forward. `Connection` adds names to this set. */
const HOP_BY_HOP = new Set(["connection", "proxy-authorization", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The request headers a forward copies upstream. Everything hop-by-hop is dropped, including any
 * header `Connection` names, so a request cannot smuggle one past the proxy's own hop. The caller's
 * `host` is dropped too: the proxy dials the allowlisted host itself, and Node derives Host from the
 * dial target, so keeping the caller's value would name a different origin upstream. A repeated or
 * comma-joined `content-length` is the request-smuggling shape, never a length this hop can trust,
 * so it is dropped and the body is framed by this hop instead. */
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
		const lower = name.toLowerCase();
		if (lower === "host") continue;
		if (lower === "content-length" && (Array.isArray(value) || String(value).includes(","))) continue;
		kept[name] = value;
	}
	return kept;
}
