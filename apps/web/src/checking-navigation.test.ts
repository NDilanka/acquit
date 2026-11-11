import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { match, ownerRouteUrl, signedOutPage } from "./route.ts";
test("checking is public and old addresses replace without dropping query or fragment", () => {
  assert.equal(signedOutPage(match("/how-work-is-checked")), "public");
  assert.equal(ownerRouteUrl("/verifiers/?source=bookmark#code"), "/how-work-is-checked?source=bookmark#code");
  assert.equal(ownerRouteUrl("/print?source=bookmark#print"), "/how-work-is-checked?source=bookmark#print");
});
test("checking has distinct code/print honesty copy and links to the inspector", () => {
  const source = readFileSync(new URL("./pages/HowWorkIsChecked.tsx", import.meta.url), "utf8");
  assert.match(source, /Code · real checks/);
  assert.match(source, /Print · file checked, machine simulated/);
  assert.match(source, /Verified is not automatic payment/);
  assert.match(source, /<Link className="text-button" to="\/inspect">Try to cheat the checker<\/Link>/);
  assert.match(source, /the machine run is simulated/);
  assert.match(source, /Print exams are coming\. Paid laser jobs are checked by the real laser checker on Acquit's server\./);
  assert.doesNotMatch(source, /Print and laser exams are/);
  assert.doesNotMatch(source, /<iframe|dangerouslySetInnerHTML/);
});
test("embedded print uses the owner's single announcement channel", () => {
  const source = readFileSync(new URL("./pages/HowWorkIsChecked.tsx", import.meta.url), "utf8");
  const print = readFileSync(new URL("./pages/PrintDemo.tsx", import.meta.url), "utf8");
  const toast = readFileSync(new URL("./toast.tsx", import.meta.url), "utf8");
  assert.match(source, /onAnnounce=\{announce\}/);
  assert.doesNotMatch(print, /role="status"/);
  assert.doesNotMatch(toast, /role="status"/);
  assert.match(toast, /aria-live="polite" aria-atomic="true"/);
});
