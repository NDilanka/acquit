// The egress allowlist is a host and a port: a lookalike host never matches, and neither does the
// right host on a port the proxy does not forward. No Docker here; the proxy module imports this one.
import assert from "node:assert/strict";
import test from "node:test";
import { allowedConnect, allowedForward, allowedHost, parseAuthority } from "../allowlist.mjs";

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
});

test("CONNECT is allowed only to 443 and a plain forward only to 80 or 443", () => {
	assert.equal(allowedConnect("registry.npmjs.org:443"), true);
	assert.equal(allowedConnect("registry.npmjs.org"), true);
	assert.equal(allowedConnect("registry.npmjs.org:81"), false);
	assert.equal(allowedConnect("registry.npmjs.org:8443"), false);
	assert.equal(allowedConnect("api.anthropic.com:8443"), false);
	assert.equal(allowedConnect("example.com:443"), false);
	assert.equal(allowedConnect("registry.npmjs.org.evil.example:443"), false);
	assert.equal(allowedConnect("registry.npmjs.org:not-a-port"), false);
	assert.equal(allowedForward("registry.npmjs.org", 80), true);
	assert.equal(allowedForward("registry.npmjs.org", 443), true);
	assert.equal(allowedForward("registry.npmjs.org", 8080), false);
	assert.equal(allowedForward("api.anthropic.com", 81), false);
	assert.equal(allowedForward("example.com", 80), false);
});
