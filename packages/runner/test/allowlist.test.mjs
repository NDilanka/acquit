// The egress allowlist is a scheme, a host, and a port: a lookalike host never matches, and neither
// does the right host on a port or scheme the proxy does not forward. No Docker here; the proxy
// module imports this one.
import assert from "node:assert/strict";
import test from "node:test";
import { allowedConnect, allowedForward, allowedHost, authorityLabel, forwardHeaders, parseAuthority } from "../allowlist.mjs";

test("only the registry and the provider hosts are allowed, exactly", () => {
	assert.equal(allowedHost("registry.npmjs.org"), true);
	assert.equal(allowedHost("api.anthropic.com"), true);
	assert.equal(allowedHost("REGISTRY.NPMJS.ORG"), true);
	assert.equal(allowedHost("registry.npmjs.org."), true);
	assert.equal(allowedHost("registry.npmjs.org.evil.example"), false);
	assert.equal(allowedHost("evilregistry.npmjs.org"), false);
	assert.equal(allowedHost("registry.npmjs.org:443"), false);
	assert.equal(allowedHost(""), false);
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
	assert.equal(allowedConnect("registry.npmjs.org:443"), true);
	assert.equal(allowedConnect("registry.npmjs.org"), true);
	assert.equal(allowedConnect("registry.npmjs.org:81"), false);
	assert.equal(allowedConnect("registry.npmjs.org:8443"), false);
	assert.equal(allowedConnect("api.anthropic.com:8443"), false);
	assert.equal(allowedConnect("example.com:443"), false);
	assert.equal(allowedConnect("registry.npmjs.org.evil.example:443"), false);
	assert.equal(allowedConnect("registry.npmjs.org:not-a-port"), false);
	assert.equal(allowedConnect("user:secret@registry.npmjs.org:443"), false);
});

test("a plain forward is an http URL on port 80, with no userinfo", () => {
	const forward = raw => allowedForward(new URL(raw));
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
		host: "registry.npmjs.org", accept: "*/*", "user-agent": "curl/8",
		connection: "keep-alive, X-Hop", "x-hop": "drop", "keep-alive": "timeout=5",
		"proxy-authorization": "Basic Zm9v", "proxy-connection": "keep-alive",
		te: "trailers", trailer: "x-trailer", "transfer-encoding": "chunked", upgrade: "websocket",
	}), { host: "registry.npmjs.org", accept: "*/*", "user-agent": "curl/8" });
	// Node delivers a repeated header as an array; every name it lists is dropped too.
	assert.deepEqual(forwardHeaders({ connection: ["close", "X-Secret"], "x-secret": "drop", "x-keep": "keep" }),
		{ "x-keep": "keep" });
});
