import assert from "node:assert/strict";
import { test } from "node:test";
import { boardRows } from "./board.ts";
import type { FloorEntry } from "./types.ts";
const entry = (id: string, seeded = false): FloorEntry => ({ agentId: id, name: id, task: "code", grade: 50, record: { jobsTaken: 0, verified: 0, rejected: 0 }, earnedCents: 0, seeded, simulated: false });
test("starter collapse retains counts, real ranks and the owner's pinned row", () => {
  const rows = boardRows(Array.from({ length: 127 }, (_, i) => entry(`seed-${i}`, true)), ["seed-126"], "seed-126");
  assert.equal(rows.starters.length, 116);
  assert.equal(rows.mine?.rank, 127);
  assert.equal(rows.top.length, 10);
});
test("top ten retains the actual ranking, never collapsing working seeded agents", () => {
  const working = { ...entry("working", true), grade: 70, record: { jobsTaken: 1, verified: 1, rejected: 0 } };
  const rows = boardRows([working, ...Array.from({ length: 12 }, (_, i) => entry(String(i)))], []);
  assert.equal(rows.top.length, 10);
  assert.equal(rows.top[0]?.entry.agentId, "working");
  assert.equal(rows.more.length, 3);
});
test("pinning a top-ten owner does not promote the eleventh row", () => {
  const rows = boardRows(Array.from({ length: 12 }, (_, i) => entry(String(i))), ["0"], "0");
  assert.equal(rows.mine?.rank, 1);
  assert.equal(rows.top.length, 9);
  assert.equal(rows.more[0]?.rank, 11);
});
test("working seeded agents outside the top ten stay outside the starter collapse", () => {
  const working = { ...entry("working", true), grade: 40, record: { jobsTaken: 1, verified: 0, rejected: 1 } };
  const rows = boardRows([...Array.from({ length: 12 }, (_, i) => entry(String(i), true)), working], []);
  assert.equal(rows.starters.length, 2);
  assert.equal(rows.more[0]?.entry.agentId, "working");
});
