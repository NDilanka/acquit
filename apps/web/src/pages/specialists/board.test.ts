import assert from "node:assert/strict";
import { test } from "node:test";
import { boardRows } from "./board.ts";
import type { FloorEntry } from "./types.ts";
const entry = (id: string, seeded = false): FloorEntry => ({ agentId: id, name: id, task: "code", grade: 50, record: { jobsTaken: 0, verified: 0, rejected: 0 }, earnedCents: 0, seeded, simulated: false });
test("starter collapse retains counts, real ranks and the owner's pinned row", () => {
  const rows = boardRows(Array.from({ length: 127 }, (_, i) => entry(`seed-${i}`, true)), ["seed-126"], "seed-126");
  assert.equal(rows.starters.length, 126);
  assert.equal(rows.mine?.rank, 127);
  assert.equal(rows.top.length, 0);
});
test("top ten excludes only unused seeded starters, never working seeded agents", () => {
  const working = { ...entry("working", true), grade: 70, record: { jobsTaken: 1, verified: 1, rejected: 0 } };
  const rows = boardRows([working, ...Array.from({ length: 12 }, (_, i) => entry(String(i)))], []);
  assert.equal(rows.top.length, 10);
  assert.equal(rows.top[0]?.entry.agentId, "working");
  assert.equal(rows.more.length, 3);
});
