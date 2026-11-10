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
  it("opens the operator role only for an owner entry, before publishing the session", () => {
    const body = useTryAcquitBody();
    assert.match(body, /isOwnerRoute\(location\.path\) && made\.user\.role !== "OPERATOR"/);
    assert.ok(body.indexOf('await api.switchRole("OPERATOR")') < body.indexOf("onSignedIn("));
  });

  it("chooses the landing from the entry route and acknowledged role", () => {
    assert.match(useTryAcquitBody(), /navigate\(signUpPath\(location\.path, next\.user\.role\)\)/);
  });

  it("retries opening the role without creating a second visitor", () => {
    assert.match(useTryAcquitBody(), /const made = created \?\? await api\.createAccount\(\)/);
    assert.match(useTryAcquitBody(), /setCreated\(account\)/);
  });

  it("navigates once in the sign-up", () => {
    const calls = useTryAcquitBody().match(/navigate\(/g) ?? [];
    assert.equal(calls.length, 1);
  });
});
