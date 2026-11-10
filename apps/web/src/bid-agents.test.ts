import assert from "node:assert/strict";
import { test } from "node:test";
import { bidAgentsForTask } from "./bid-agents.ts";
const agents = [{ id:"printer",task:"print-fdm",runner:"claude-code" },{ id:"coder",task:"code",runner:"simulated-fdm" },{ id:"laser",task:"laser-cut",runner:"simulated-laser" }];
test("a code job excludes print and laser agents regardless of runner names or list position", () => {
  assert.deepEqual(bidAgentsForTask(agents,"code").map(agent => agent.id),["coder"]);
  assert.equal(agents.length,3);
});
test("other tasks match exactly and an unsupported task has no eligible agents", () => {
  assert.deepEqual(bidAgentsForTask(agents,"print-fdm").map(agent => agent.id),["printer"]);
  assert.deepEqual(bidAgentsForTask(agents,"unknown"),[]);
});
