// The demo's address gate, decided from the parsed ACQUIT_DEMO_ALLOW_IPS value and one client address.
// Only documentation addresses (RFC 5737, RFC 3849) appear here, never a deployment's own address.

import assert from "node:assert/strict";
import { test } from "node:test";
import { demoOpenTo, parseDemoAllowlist } from "../src/demo-access.ts";

test("an unset, empty, or separators-only allowlist leaves the demo open to every address", () => {
  for (const raw of [undefined, "", "   ", " , ,"]) {
    assert.deepEqual(parseDemoAllowlist(raw), { open: true });
    assert.equal(demoOpenTo(parseDemoAllowlist(raw), "192.0.2.10"), true);
    assert.equal(demoOpenTo(parseDemoAllowlist(raw), "2001:db8::5"), true);
  }
});

test("a listed address is allowed and an unlisted one is denied", () => {
  const allowlist = parseDemoAllowlist("192.0.2.10,198.51.100.7");
  assert.equal(demoOpenTo(allowlist, "192.0.2.10"), true);
  assert.equal(demoOpenTo(allowlist, "198.51.100.7"), true);
  assert.equal(demoOpenTo(allowlist, "192.0.2.11"), false);
  assert.equal(demoOpenTo(allowlist, "unknown"), false);
});

test("an IPv4-mapped IPv6 address matches its IPv4 form on either side", () => {
  assert.equal(demoOpenTo(parseDemoAllowlist("192.0.2.10"), "::ffff:192.0.2.10"), true);
  assert.equal(demoOpenTo(parseDemoAllowlist("::ffff:198.51.100.7"), "198.51.100.7"), true);
  assert.equal(demoOpenTo(parseDemoAllowlist("::ffff:198.51.100.7"), "::ffff:198.51.100.8"), false);
  assert.equal(demoOpenTo(parseDemoAllowlist("::FFFF:192.0.2.10"), "::ffff:c000:20a"), true);
});

test("whitespace and empty entries are ignored", () => {
  assert.deepEqual(parseDemoAllowlist("  192.0.2.10 ,, ,\t198.51.100.7  ,"), {
    open: false,
    addresses: new Set(["192.0.2.10", "198.51.100.7"]),
  });
});

test("an IPv6 address compares in its canonical form", () => {
  const allowlist = parseDemoAllowlist("2001:DB8:0:0::5");
  assert.equal(demoOpenTo(allowlist, "2001:db8::5"), true);
  assert.equal(demoOpenTo(allowlist, "2001:db8::6"), false);
});

test("an entry that is not an IP address refuses by name, without echoing the value", () => {
  assert.throws(() => parseDemoAllowlist("192.0.2.10, not-an-address"), {
    message: "Invalid configuration: ACQUIT_DEMO_ALLOW_IPS lists an entry that is not an IP address.",
  });
  assert.throws(() => parseDemoAllowlist("192.0.2.300"), /ACQUIT_DEMO_ALLOW_IPS lists an entry that is not an IP address/);
});
