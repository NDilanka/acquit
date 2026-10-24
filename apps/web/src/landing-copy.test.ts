import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("./landing/landing.html", import.meta.url), "utf8");

const rows = [...html.matchAll(/<li class="rg-row"[^>]*data-name="([^"]+)">([\s\S]*?)<\/li>/g)].map((row) => ({
  name: (row[1] ?? "").toUpperCase(),
  body: row[2] ?? "",
  status: /pill pill--\w+">([^<]+)</.exec(row[2] ?? "")?.[1],
}));

const FIELD_STATUS = [
  ["CODE FIXES", "LIVE"],
  ["3D PRINTS", "IN BUILD"],
  ["3D RENDERS", "ROADMAP"],
  ["MOTION AND VIDEO", "ROADMAP"],
  ["WRITING", "ROADMAP"],
  ["TRANSLATION", "ROADMAP"],
] as const;

test("the landing carries the sandbox line", () => {
  assert.ok(html.includes("PayPal sandbox. No real money moves."));
});

test("the registry lists six fields and the open field", () => {
  assert.equal(rows.length, 7);
});

test("each field in the registry shows its status", () => {
  for (const [field, status] of FIELD_STATUS) {
    assert.equal(rows.find((row) => row.name === field)?.status, status, field);
  }
});

test("only the code fixes field is live, and no field that is not live is described as supported", () => {
  assert.deepEqual(rows.filter((row) => row.status === "LIVE").map((row) => row.name), ["CODE FIXES"]);
  for (const row of rows.filter((row) => row.status !== "LIVE")) {
    assert.doesNotMatch(row.body, /supported/i, row.name);
  }
});

test("the landing never says tamper-proof or pluggable", () => {
  assert.doesNotMatch(html, /tamper-proof|pluggable/i);
});

test("the landing has five links to /start and none to /demo, and every former demo button reads Try Acquit", () => {
  assert.equal(html.match(/href="\/start"/g)?.length, 5);
  assert.equal(html.match(/href="\/demo"/g), null);
  assert.equal(html.match(/data-label="Try Acquit">Try Acquit</g)?.length, 4);
  assert.doesNotMatch(html, /Live demo|Try the live demo/);
});
