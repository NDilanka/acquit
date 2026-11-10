import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// SignIn.tsx has no render harness, so these read its source: the sign-up landing is one call inside useTryAcquit.
const source = readFileSync(new URL("../SignIn.tsx", import.meta.url), "utf8");

/** The text of useTryAcquit, from its declaration to its return. */
function useTryAcquitBody(): string {
  const from = source.indexOf("export function useTryAcquit");
  const to = source.indexOf("return { state, setState, error, start };", from);
  assert.ok(from >= 0 && to > from, "useTryAcquit is in SignIn.tsx");
  return source.slice(from, to);
}

describe("sign-up landing", () => {
  it("sends a new account to the specialists page", () => {
    assert.match(useTryAcquitBody(), /navigate\("\/specialists"\)/);
  });

  it("no longer sends a new account to the home page", () => {
    assert.doesNotMatch(useTryAcquitBody(), /navigate\("\/"\)/);
    assert.doesNotMatch(source, /navigate\("\/"\)/);
  });

  it("routes only the sign-up through the specialists page", () => {
    const calls = source.match(/navigate\("\/specialists"\)/g) ?? [];
    assert.equal(calls.length, 1);
  });
});
