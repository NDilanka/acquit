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
  it("sends an operator sign-up to the specialists page", () => {
    assert.match(useTryAcquitBody(), /navigate\(made\.user\.role === "OPERATOR" \? "\/specialists" : "\/"\)/);
  });

  it("sends every other sign-up, a client's, to the home page where clients landed before", () => {
    assert.match(useTryAcquitBody(), /: "\/"\)/);
  });

  it("never sends a sign-up to the specialists page unconditionally", () => {
    assert.doesNotMatch(useTryAcquitBody(), /navigate\("\/specialists"\)/);
    assert.doesNotMatch(source, /navigate\("\/specialists"\)/);
  });

  it("navigates once in the sign-up", () => {
    const calls = useTryAcquitBody().match(/navigate\(/g) ?? [];
    assert.equal(calls.length, 1);
  });
});
