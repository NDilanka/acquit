import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureApi } from "./fixtures.ts";

describe("fixture exam reads", () => {
  it("returns a new exam object on each read of an open run", async () => {
    const agent = await fixtureApi.plugSample("code-fixer");
    const started = await fixtureApi.startExam(agent.id);
    const first = await fixtureApi.exam(agent.id, started.id);
    const second = await fixtureApi.exam(agent.id, started.id);
    assert.notEqual(first.exam, second.exam);
    assert.equal(first.exam.status, "RUNNING");
    assert.equal(second.exam.status, "RUNNING");
  });

  it("moves an open run on to a final status, with the counts it sealed", async () => {
    const agent = await fixtureApi.plugSample("print-fdm");
    const started = await fixtureApi.startExam(agent.id);
    const statuses: string[] = [];
    let last = await fixtureApi.exam(agent.id, started.id);
    statuses.push(last.exam.status);
    for (let i = 0; i < 3; i += 1) {
      last = await fixtureApi.exam(agent.id, started.id);
      statuses.push(last.exam.status);
    }
    assert.deepEqual(statuses, ["RUNNING", "RUNNING", "VERIFYING", "PASSED"]);
    assert.deepEqual(last.exam.hidden, { passed: 1, total: 1 });
    assert.equal(last.acquitted, true);
  });
});
