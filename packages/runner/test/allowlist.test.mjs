// The egress allowlist is a scheme, a host, and a port: a lookalike host never matches, and neither
// does the right host on a port or scheme the proxy does not forward. The host set is the registry
// plus the one provider host the CLI named, and a provider outside the known table refuses the set.
// No Docker here; the proxy module imports this one.
import assert from "node:assert/strict";
import test from "node:test";
import { allowedConnect, allowedForward, allowedHost, allowedHosts, authorityLabel, forwardHeaders, parseAuthority, providerHosts } from "../allowlist.mjs";

test("only the registry and the provider host are allowed, exactly", () => {
	const hosts = allowedHosts(undefined);
	assert.equal(allowedHost("registry.npmjs.org", hosts), true);
	assert.equal(allowedHost("api.anthropic.com", hosts), true);
	assert.equal(allowedHost("REGISTRY.NPMJS.ORG", hosts), true);
	assert.equal(allowedHost("registry.npmjs.org.", hosts), true);
	assert.equal(allowedHost("registry.npmjs.org.evil.example", hosts), false);
	assert.equal(allowedHost("evilregistry.npmjs.org", hosts), false);
	assert.equal(allowedHost("registry.npmjs.org:443", hosts), false);
	assert.equal(allowedHost("", hosts), false);
});

test("the provider hosts are the ones the run named, and only providers the table knows", () => {
	// The CLI passes the run's provider host (or comma-joined hosts); nothing named is Anthropic,
	// and every other value is refused rather than trusted, so an environment value can never
	// widen egress.
	assert.deepEqual(providerHosts(undefined), ["api.anthropic.com"]);
	assert.deepEqual(providerHosts(""), ["api.anthropic.com"]);
	assert.deepEqual(providerHosts("api.anthropic.com"), ["api.anthropic.com"]);
	assert.deepEqual(providerHosts("openrouter.ai"), ["openrouter.ai"]);
	assert.deepEqual(providerHosts("OPENROUTER.AI."), ["openrouter.ai"]);
	assert.equal(providerHosts("evil.example"), null);
	assert.equal(providerHosts("openrouter.ai.evil.example"), null);
	assert.equal(providerHosts("registry.npmjs.org"), null);
	assert.equal(allowedHosts("evil.example"), null);
});

test("droid's Factory hosts are known providers, named one by one or comma-joined", () => {
	assert.deepEqual(providerHosts("api.factory.ai"), ["api.factory.ai"]);
	assert.deepEqual(providerHosts("prem.factory.ai"), ["prem.factory.ai"]);
	assert.deepEqual(providerHosts("api.factory.ai,prem.factory.ai"), ["api.factory.ai", "prem.factory.ai"]);
	assert.deepEqual(providerHosts("API.FACTORY.AI, PREM.FACTORY.AI."), ["api.factory.ai", "prem.factory.ai"]);
	assert.equal(providerHosts("api.factory.ai,evil.example"), null, "one bad element refuses the whole value");
	// A host droid contacts without needing (telemetry is non-fatal through the proxy) never joins.
	assert.equal(providerHosts("telemetry.factory.ai"), null);
});

test("under the droid provider the proxy allows both Factory hosts and refuses the rest", () => {
	const hosts = allowedHosts("api.factory.ai,prem.factory.ai");
	assert.deepEqual([...hosts].sort(), ["api.factory.ai", "prem.factory.ai", "registry.npmjs.org"]);
	assert.equal(allowedConnect("api.factory.ai:443", hosts), true);
	assert.equal(allowedConnect("prem.factory.ai:443", hosts), true);
	assert.equal(allowedConnect("registry.npmjs.org:443", hosts), true);
	assert.equal(allowedConnect("example.com:443", hosts), false);
	assert.equal(allowedConnect("telemetry.factory.ai:443", hosts), false);
	assert.equal(allowedConnect("api.factory.ai:80", hosts), false);
	assert.equal(allowedConnect("evil-api.factory.ai:443", hosts), false);
});

test("under openrouter, api.anthropic.com is denied and openrouter.ai is allowed", () => {
	const hosts = allowedHosts("openrouter.ai");
	assert.deepEqual([...hosts].sort(), ["openrouter.ai", "registry.npmjs.org"]);
	assert.equal(allowedConnect("openrouter.ai:443", hosts), true);
	assert.equal(allowedConnect("api.anthropic.com:443", hosts), false);
	assert.equal(allowedConnect("openrouter.ai:80", hosts), false);
	assert.equal(allowedConnect("registry.npmjs.org:443", hosts), true);
	assert.equal(allowedForward(new URL("http://openrouter.ai/v1/messages"), hosts), true);
	assert.equal(allowedForward(new URL("http://api.anthropic.com/v1/messages"), hosts), false);
});

test("a CONNECT authority parses host:port, a bare host, and IPv6 brackets", () => {
	assert.deepEqual(parseAuthority("registry.npmjs.org:443"), { host: "registry.npmjs.org", port: 443 });
	assert.deepEqual(parseAuthority("registry.npmjs.org"), { host: "registry.npmjs.org", port: 443 });
	assert.deepEqual(parseAuthority("[::1]:443"), { host: "::1", port: 443 });
	assert.deepEqual(parseAuthority("[::1]"), { host: "::1", port: 443 });
	assert.equal(parseAuthority("registry.npmjs.org:not-a-port"), null);
	assert.equal(parseAuthority("registry.npmjs.org:"), null);
	assert.equal(parseAuthority("[::1"), null);
	assert.equal(parseAuthority(""), null);
	// A CONNECT authority is host[:port]; userinfo is not part of that form.
	assert.equal(parseAuthority("user:secret@example.com:443"), null);
});

test("a denial names the parsed host and port, never the raw authority", () => {
	assert.equal(authorityLabel("example.com:443"), "example.com:443");
	assert.equal(authorityLabel("registry.npmjs.org"), "registry.npmjs.org:443");
	assert.equal(authorityLabel("[::1]:8443"), "::1:8443");
	// The authority a denial log prints must not repeat a credential the caller put in its userinfo.
	assert.equal(authorityLabel("user:secret@example.com:443"), "<unparseable>");
	assert.equal(authorityLabel("registry.npmjs.org:not-a-port"), "<unparseable>");
	assert.equal(authorityLabel(""), "<unparseable>");
});

test("CONNECT is allowed only to 443", () => {
	const hosts = allowedHosts(undefined);
	assert.equal(allowedConnect("registry.npmjs.org:443", hosts), true);
	assert.equal(allowedConnect("registry.npmjs.org", hosts), true);
	assert.equal(allowedConnect("registry.npmjs.org:81", hosts), false);
	assert.equal(allowedConnect("registry.npmjs.org:8443", hosts), false);
	assert.equal(allowedConnect("api.anthropic.com:8443", hosts), false);
	assert.equal(allowedConnect("example.com:443", hosts), false);
	assert.equal(allowedConnect("registry.npmjs.org.evil.example:443", hosts), false);
	assert.equal(allowedConnect("registry.npmjs.org:not-a-port", hosts), false);
	assert.equal(allowedConnect("user:secret@registry.npmjs.org:443", hosts), false);
});

test("a plain forward is an http URL on port 80, with no userinfo", () => {
	const hosts = allowedHosts(undefined);
	const forward = raw => allowedForward(new URL(raw), hosts);
	assert.equal(forward("http://registry.npmjs.org/"), true);
	assert.equal(forward("http://registry.npmjs.org:80/"), true);
	assert.equal(forward("http://api.anthropic.com/path?query=1"), true);
	assert.equal(forward("https://registry.npmjs.org/"), false);
	assert.equal(forward("ftp://registry.npmjs.org/"), false);
	assert.equal(forward("http://user:pass@registry.npmjs.org/"), false);
	assert.equal(forward("http://token@registry.npmjs.org/"), false);
	assert.equal(forward("http://registry.npmjs.org:443/"), false);
	assert.equal(forward("http://api.anthropic.com:81/"), false);
	assert.equal(forward("http://example.com/"), false);
	assert.equal(forward("http://registry.npmjs.org.evil.example/"), false);
});

test("a forward strips connection management, proxy credentials, and whatever Connection names", () => {
	assert.deepEqual(forwardHeaders({
		accept: "*/*", "user-agent": "curl/8",
		connection: "keep-alive, X-Hop", "x-hop": "drop", "keep-alive": "timeout=5",
		"proxy-authorization": "Basic Zm9v", "proxy-connection": "keep-alive",
		te: "trailers", trailer: "x-trailer", "transfer-encoding": "chunked", upgrade: "websocket",
	}), { accept: "*/*", "user-agent": "curl/8" });
	// Node delivers a repeated header as an array; every name it lists is dropped too.
	assert.deepEqual(forwardHeaders({ connection: ["close", "X-Secret"], "x-secret": "drop", "x-keep": "keep" }),
		{ "x-keep": "keep" });
});

test("a forward drops the caller's host and any repeated or comma-joined content-length", () => {
	// The proxy dials the allowlisted host itself, so Node derives Host from the dial target; a
	// caller's host would name a different origin upstream.
	assert.deepEqual(forwardHeaders({ host: "registry.npmjs.org", accept: "*/*" }), { accept: "*/*" });
	assert.deepEqual(forwardHeaders({ host: "evil.example", "content-length": "5", accept: "*/*" }),
		{ "content-length": "5", accept: "*/*" });
	// A repeated or comma-joined length is the smuggling shape, never a length this hop can trust.
	assert.deepEqual(forwardHeaders({ "content-length": ["5", "6"], accept: "*/*" }), { accept: "*/*" });
	assert.deepEqual(forwardHeaders({ "content-length": "5, 6", accept: "*/*" }), { accept: "*/*" });
});
