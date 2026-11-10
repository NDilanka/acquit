import assert from "node:assert/strict";
import { test } from "node:test";
import { boardRows } from "./board.ts";
import type { FloorEntry } from "./types.ts";
const entry = (id: string, seeded = false): FloorEntry => ({ agentId: id, name: id, task: "code", grade: 50, record: { jobsTaken: 0, verified: 0, rejected: 0 }, earnedCents: 0, seeded, simulated: false });
test("identical starters collapse before the seven-row cut without hiding the owner", () => {
  const rows = boardRows(Array.from({ length: 127 }, (_, i) => entry(`seed-${i}`, true)), ["seed-126"], "seed-126");
  assert.equal(rows.mine?.rank, 127);
  assert.equal(rows.top.length, 1);
  assert.equal(rows.top[0]?.members?.length, 126);
  assert.equal(rows.top[0]?.rank, 1);
});
test("seven rows retain real ranks and never collapse working seeded agents", () => {
  const working = { ...entry("working", true), grade: 70, record: { jobsTaken: 1, verified: 1, rejected: 0 } };
  const rows = boardRows([working, ...Array.from({ length: 12 }, (_, i) => entry(String(i)))], []);
  assert.equal(rows.top.length, 7);
  assert.equal(rows.top[0]?.entry.agentId, "working");
  assert.equal(rows.more.length, 6);
});
test("a pinned owner keeps its rank while seven other rows remain visible", () => {
  const rows = boardRows(Array.from({ length: 12 }, (_, i) => entry(String(i))), ["0"], "0");
  assert.equal(rows.mine?.rank, 1);
  assert.equal(rows.top.length, 7);
  assert.equal(rows.top[0]?.rank, 2);
  assert.equal(rows.more[0]?.rank, 9);
});
test("working seeded agents never join the starter collapse", () => {
  const working = { ...entry("working", true), grade: 40, record: { jobsTaken: 1, verified: 0, rejected: 1 } };
  const rows = boardRows([...Array.from({ length: 12 }, (_, i) => entry(String(i), true)), working], []);
  assert.equal(rows.top[0]?.members?.length, 12);
  assert.equal(rows.top[1]?.entry.agentId, "working");
});
test("different grades, tasks and simulation flags form separate groups", () => {
  const rows=boardRows([entry("a",true),{...entry("b",true),grade:55},{...entry("c",true),simulated:true}],[]);
  assert.equal(rows.top.length,3);
});
