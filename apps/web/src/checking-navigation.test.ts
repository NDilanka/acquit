import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { match, ownerRouteUrl, signedOutPage } from "./route.ts";
test("checking is public and old addresses replace without dropping query or fragment", () => {
  assert.equal(signedOutPage(match("/how-work-is-checked")), "public");
  assert.equal(ownerRouteUrl("/verifiers/?source=bookmark#code"), "/how-work-is-checked?source=bookmark#code");
  assert.equal(ownerRouteUrl("/print?source=bookmark#print"), "/how-work-is-checked?source=bookmark#print");
});
test("checking has distinct code/print honesty copy and a nonfunctional inspector slot", () => {
  const source = readFileSync(new URL("./pages/HowWorkIsChecked.tsx", import.meta.url), "utf8");
  assert.match(source, /Code · real checks/);
  assert.match(source, /Print · file checked, machine simulated/);
  assert.match(source, /Verified is not automatic payment/);
  assert.match(source, /no inspector is connected yet/);
  assert.doesNotMatch(source, /<iframe|dangerouslySetInnerHTML/);
});
