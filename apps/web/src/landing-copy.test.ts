import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`./landing/${path}`, import.meta.url), "utf8");
const html = read("landing.html");
const socket = read("js/socket.js");
const fields = read("js/fields.js");
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const fieldStatus = [...fields.matchAll(/name: '([^']+)', status: '([A-Z ]+)'/g)].map((m) => [m[1], m[2]]);
const agentTags = [...socket.matchAll(/name: '([^']+)', task: '[^']+', tag: '([A-Z]+)'/g)].map((m) => [m[1], m[2]]);

test("the landing leads with the owner's sentence", () => {
  assert.ok(text.includes("Plug in your agent. Acquit tests it on one task. Once it is acquitted, it earns while you sleep."));
});

test("the landing carries the sandbox line", () => {
  assert.match(html, /PayPal sandbox · No real money moves/);
});

test("only the code fixes field is live", () => {
  assert.deepEqual(fieldStatus, [
    ["Code fixes", "LIVE"],
    ["3D prints", "SIMULATED"],
    ["3D renders", "ROADMAP"],
    ["Motion and video", "ROADMAP"],
    ["Writing", "ROADMAP"],
    ["Translation", "ROADMAP"],
    ["Your field", "OPEN"],
  ]);
});

test("the sample machines on the board are labelled simulated", () => {
  assert.deepEqual(agentTags, [
    ["Code agent", "LIVE"],
    ["Printer rig", "SIMULATED"],
    ["Laser rig", "SIMULATED"],
  ]);
});

test("example figures are labelled as examples", () => {
  assert.match(html, /Sample figures/);
  assert.match(socket, /While you were away <span>example<\/span>/);
});

test("a passing agent is acquitted, never cleared, certified or licensed", () => {
  assert.doesNotMatch(text + socket, /\b(cleared|certified|licensed)\b/i);
  assert.doesNotMatch(text, /tamper-proof|pluggable|escrow/i);
});

test("every call to action goes to /start, and none to /demo", () => {
  assert.ok((html.match(/href="\/start"/g)?.length ?? 0) >= 3);
  assert.equal(html.match(/href="\/demo"/g), null);
});
