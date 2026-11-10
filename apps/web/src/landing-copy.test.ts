import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`./landing/${path}`, import.meta.url), "utf8");
const html = read("landing.html");
const socket = read("js/socket.js");
const footer = read("js/footer.js");
const fields = read("js/fields.js");
const meta = read("index.ts");
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const fieldStatus = [...fields.matchAll(/name: '([^']+)', status: '([A-Z ]+)'/g)].map((m) => [m[1], m[2]]);
const agentTags = [...socket.matchAll(/name: '([^']+)', task: '[^']+', tag: '([A-Z]+)'/g)].map((m) => [m[1], m[2]]);

test("the landing leads with the tagline and its supporting line", () => {
  const supporting = "Acquit tests it once, finds it jobs, and pays you through PayPal when the work is verified.";
  assert.ok(text.includes(`Plug in your agent. ${supporting}`));
  assert.match(meta, /const TITLE = "Acquit\. Plug in your agent\.";/);
  assert.match(meta, /const DESCRIPTION =\s+"Acquit tests it once, finds it jobs, and pays you through PayPal when the work is verified\.";/);
  assert.match(footer, /title: 'Plug in your agent\.'/);
});

test("the landing never says sleep or the retired build-once tagline", () => {
  assert.doesNotMatch(text + socket + footer + meta, /\bsleep|build once/i);
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
  assert.match(socket, /Since you last looked <span>example<\/span>/);
});

test("the landing carries no clock framing", () => {
  assert.doesNotMatch(text + socket + footer, /overnight|while you slept|while you were away|tonight|the morning/i);
});

test("print and laser samples show exam coming, only code agents show acquitted", () => {
  assert.match(socket, /a\.sim \? 'Exam coming' : 'Acquitted · Simulated'/);
  assert.match(socket, /a\.sim \? 'Exam coming' : 'Acquitted'/);
});

test("a passing agent is acquitted, never cleared, certified or licensed", () => {
  assert.doesNotMatch(text + socket, /\b(cleared|certified|licensed)\b/i);
  assert.doesNotMatch(text, /tamper-proof|pluggable|escrow/i);
});

test("every call to action goes to /start, and none to /demo", () => {
  assert.ok((html.match(/href="\/start"/g)?.length ?? 0) >= 3);
  assert.equal(html.match(/href="\/demo"/g), null);
});
