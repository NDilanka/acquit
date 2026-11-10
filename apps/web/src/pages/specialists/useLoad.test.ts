import assert from "node:assert/strict";
import { test } from "node:test";
import { loadForKey } from "./useLoad.ts";

test("new agent/principal keys immediately hide old data and errors while retaining same-key refresh data", () => {
  const error = new Error("Previous read failed");
  const snapshot = { key:"owner-a:agent-a",data:{name:"Agent A"},error };
  assert.deepEqual(loadForKey(snapshot,"owner-b:agent-b"),{data:null,error:null});
  assert.deepEqual(loadForKey(snapshot,snapshot.key),{data:snapshot.data,error});
});
