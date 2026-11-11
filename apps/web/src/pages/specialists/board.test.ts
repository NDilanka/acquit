import assert from "node:assert/strict";
import { test } from "node:test";
import { boardRows, HOUSE_AGENT_ID } from "./board.ts";
import type { FloorEntry } from "./types.ts";
const entry = (id: string, seeded = false): FloorEntry => ({ agentId: id, name: id, task: "code", grade: 50, record: { jobsTaken: 0, verified: 0, rejected: 0 }, earnedCents: 0, seeded, simulated: false });
test("identical starters collapse before the seven-row cut without hiding the owner", () => {
  const rows = boardRows(Array.from({ length: 127 }, (_, i) => entry(`seed-${i}`, true)), ["seed-126"], "seed-126");
  assert.equal(rows.mine?.rank, 127);
  assert.equal(rows.top.length, 1);
  assert.equal(rows.top[0]?.members?.length, 126);
  assert.equal(rows.top[0]?.rank, 1);
});
test("seven rows retain real ranks and a distinct working seeded agent", () => {
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
  const rows=boardRows([entry("a",true),{...entry("b",true),grade:55},{...entry("c",true),simulated:true},{...entry("d",true),task:"print-fdm"}],[]);
  assert.equal(rows.top.length,4);
});

test("paid seeded clones collapse with original ranks and recoverable members, but never paid visitors or owners", () => {
  const paid = (id:string): FloorEntry => ({...entry(id,true),grade:55,record:{jobsTaken:9,verified:9,rejected:0},earnedCents:32740});
  const house = {...entry("house"),grade:90};
  const visitor = {...paid("visitor"),seeded:false};
  const entries = [house,...Array.from({length:139},(_,i) => paid(`clone-${i}`)),visitor];
  const rows = boardRows(entries,["clone-138"],"clone-138");
  assert.equal(rows.mine?.rank,140);
  assert.deepEqual(rows.top.map(row => row.entry.agentId),["house","clone-0","visitor"]);
  const group = rows.top[1]!;
  assert.equal(group.rank,2);
  assert.equal(group.members?.length,138);
  assert.deepEqual(group.members?.map(row => row.rank),Array.from({length:138},(_,i) => i+2));
  assert.deepEqual(group.members?.map(row => row.entry.agentId),entries.slice(1,139).map(row => row.agentId));
  assert.equal(rows.top[2]?.rank,141);
  assert.equal(rows.top[2]?.members,undefined);
});

test("seeded groups split on jobs taken, verified, rejected and earned, even at the same grade", () => {
  const base = entry("a",true);
  const rows = boardRows([base,
    {...base,agentId:"taken",record:{...base.record,jobsTaken:1}},
    {...base,agentId:"verified",record:{...base.record,verified:1}},
    {...base,agentId:"rejected",record:{...base.record,rejected:1}},
    {...base,agentId:"earned",earnedCents:1},
    {...base,agentId:"b"},
  ],[]);
  assert.equal(rows.top.length,5);
  assert.deepEqual(rows.top[0]?.members?.map(row => row.rank),[1,6]);
  assert.deepEqual(rows.top.map(row => row.rank),[1,2,3,4,5]);
});

test("House stays distinct from identical seeded practice agents and retains its real rank", () => {
  const house = entry(HOUSE_AGENT_ID,true);
  const rows = boardRows([entry("a",true),house,entry("b",true)],[]);
  assert.equal(rows.house?.rank,2);
  assert.equal(Object.hasOwn(rows.house!,"members"),false);
  assert.deepEqual(rows.top[0]?.members?.map(row => row.rank),[1,3]);
  assert.equal(boardRows([house],[HOUSE_AGENT_ID]).house,undefined);
});
