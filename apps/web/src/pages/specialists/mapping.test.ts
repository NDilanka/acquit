import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  agentOf,
  examOf,
  examReadOf,
  examReplayOf,
  floorOf,
  nightReplayOf,
  plugOf,
  publicAgentOf,
  reportOf,
  type RawExamReplay,
  type RawNightReplay,
} from "./mapping.ts";

const shipped = (name: string) => JSON.parse(readFileSync(new URL(`../../../public/replays/${name}.json`, import.meta.url), "utf8"));

const rawAgent = {
  id: "agt_1",
  name: "Code fixer",
  task: "code" as const,
  runner: "claude-code",
  sample: "code-fixer",
  grade: 50,
};

describe("agent mapping", () => {
  it("preserves public owner/date but never turns missing earnings into zero", () => {
    const agent = publicAgentOf({ ...rawAgent, acquittal: { examId: "exam_9", at: "2026-11-09T20:00:00Z" },
      owner: { handle: "owner" }, record: { jobsTaken: 0, verified: 0, rejected: 0 } });
    assert.equal(agent.earnedCents, undefined);
    assert.equal(agent.ownerHandle, "owner");
    assert.equal(agent.acquittedAt, "2026-11-09T20:00:00Z");
    assert.equal(agent.examId, "exam_9");
  });
  it("reads acquitted and seeded from the acquittal on the owner's list", () => {
    const fresh = agentOf({ ...rawAgent, acquittal: null });
    assert.equal(fresh.acquitted, false);
    assert.equal(fresh.seeded, false);

    const acquitted = agentOf({ ...rawAgent, acquittal: { examId: "exam_9", at: "2026-11-09T20:00:00.000Z" } });
    assert.equal(acquitted.acquitted, true);
    assert.equal(acquitted.seeded, false);
    assert.equal(acquitted.simulated, false);
    assert.equal(acquitted.acquittedAt, "2026-11-09T20:00:00.000Z");
    assert.equal(acquitted.examId, "exam_9");

    const seeded = agentOf({ ...rawAgent, acquittal: { examId: "seed", at: "2026-11-09T20:00:00.000Z", seeded: true } });
    assert.equal(seeded.acquitted, true);
    assert.equal(seeded.seeded, true);
  });

  it("reads simulated from the acquittal on the owner's list, and only when the acquittal says so", () => {
    const simulated = agentOf({ ...rawAgent, acquittal: { examId: "exam_9", at: "2026-11-09T20:00:00.000Z", simulated: true } });
    assert.equal(simulated.acquitted, true);
    assert.equal(simulated.simulated, true);
    assert.equal(agentOf({ ...rawAgent, acquittal: null }).simulated, false);
  });

  it("keeps standing orders null when the list omits them", () => {
    assert.equal(agentOf({ ...rawAgent, acquittal: null }).standingOrders, null);
  });

  it("carries the bid gate from the list and the agent read, and nulls it when absent", () => {
    assert.equal(agentOf({ ...rawAgent, acquittal: null, gate: "NOT_ACQUITTED" }).gate, "NOT_ACQUITTED");
    assert.equal(agentOf({ ...rawAgent, acquittal: null }).gate, null);

    const record = { jobsTaken: 0, verified: 0, rejected: 0, earnedCents: 0 };
    const open = publicAgentOf({
      id: "agt_5",
      name: "C",
      task: "code",
      runner: "claude-code",
      acquittal: { examId: "exam_3", at: "2026-11-09T20:00:00.000Z" },
      grade: 50,
      gate: "OPEN",
      record,
    });
    assert.equal(open.gate, "OPEN");
    const printer = publicAgentOf({
      id: "agt_6",
      name: "D",
      task: "print-fdm",
      runner: "simulated-fdm",
      acquittal: null,
      grade: null,
      gate: "WRONG_TASK",
      record,
    });
    assert.equal(printer.gate, "WRONG_TASK");
    assert.equal(publicAgentOf({ id: "agt_7", name: "E", task: "code", runner: "claude-code", acquittal: null, grade: null, record }).gate, null);
  });

  it("is never acquitted or seeded when plugged in", () => {
    const plugged = plugOf({ id: "agt_2", name: "Printer", task: "print-fdm", runner: "simulated-fdm", sample: "print-fdm" });
    assert.equal(plugged.acquitted, false);
    assert.equal(plugged.seeded, false);
    assert.equal(plugged.simulated, false);
    assert.equal(plugged.grade, null);
  });

  it("reads the public agent's acquittal and seeded from the acquittal", () => {
    const record = { jobsTaken: 2, verified: 1, rejected: 0, earnedCents: 1000 };
    const open = publicAgentOf({ id: "agt_3", name: "A", task: "code", runner: "claude-code", acquittal: null, grade: null, record });
    assert.equal(open.acquitted, false);
    assert.equal(open.seeded, false);
    assert.equal(open.earnedCents, 1000);

    const seeded = publicAgentOf({
      id: "agt_4",
      name: "B",
      task: "code",
      runner: "claude-code",
      acquittal: { examId: "seed", at: "2026-11-09T20:00:00.000Z", seeded: true },
      grade: 55,
      record,
    });
    assert.equal(seeded.acquitted, true);
    assert.equal(seeded.seeded, true);
    assert.deepEqual(seeded.record, { jobsTaken: 2, verified: 1, rejected: 0 });

    const simulated = publicAgentOf({
      id: "agt_8",
      name: "F",
      task: "code",
      runner: "claude-code",
      acquittal: { examId: "exam_8", at: "2026-11-09T20:00:00.000Z", simulated: true },
      grade: 50,
      record,
    });
    assert.equal(simulated.simulated, true);
    assert.equal(open.simulated, false);
  });
});

describe("exam mapping", () => {
  it("fills missing counts and reasons with empty values", () => {
    const exam = examOf({ id: "exam_1", status: "RUNNING" });
    assert.equal(exam.visible, null);
    assert.equal(exam.hidden, null);
    assert.deepEqual(exam.reasons, []);
    assert.equal(exam.endedAt, null);
    assert.equal(exam.startedAt, null);
    assert.equal(exam.simulated, false);
  });

  it("preserves supplied simulation metadata without inferring it", () => {
    assert.equal(examOf({ id: "sim", status: "PASSED", simulated: true }).simulated, true);
    assert.equal(examOf({ id: "live", status: "PASSED", simulated: false }).simulated, false);
  });

  it("reads simulated from the run, and is false when the run omits it", () => {
    assert.equal(examOf({ id: "exam_1", status: "RUNNING", simulated: true }).simulated, true);
    assert.equal(examOf({ id: "exam_2", status: "PASSED" }).simulated, false);
  });

  it("reads acquitted for the exam read from the agent's acquittal", () => {
    const exam = { id: "exam_1", status: "PASSED" as const, visible: { passed: 5, total: 5 }, hidden: { passed: 3, total: 3 } };
    assert.equal(examReadOf({ exam, agent: { acquittal: null } }).acquitted, false);
    assert.equal(examReadOf({ exam, agent: { acquittal: { examId: "exam_1", at: "2026-11-09T20:00:00.000Z" } } }).acquitted, true);
  });
});

describe("replay mapping", () => {
  const exam = {
    id: "sample",
    status: "PASSED" as const,
    visible: { passed: 4, total: 5 },
    hidden: { passed: 2, total: 3 },
    reasons: [],
    startedAt: "2026-11-09T21:40:00.000Z",
    endedAt: "2026-11-09T21:42:00.000Z",
  };

  it("marks a replay with no recordedAt as sample data", () => {
    const replay: RawExamReplay = { recordedAt: null, simulated: false, task: "code", exam };
    const mapped = examReplayOf(replay);
    assert.equal(mapped.source, "fixture");
    assert.equal(mapped.simulated, false);
    assert.equal(mapped.task, "code");
    assert.equal(mapped.outcome, "PASSED");
    assert.equal(mapped.recordedAt, null);
    assert.equal(mapped.endedAt, exam.endedAt);
  });

  it("marks a replay with recordedAt as a recorded run", () => {
    const mapped = examReplayOf({ recordedAt: "2026-11-09T21:40:00.000Z", simulated: true, task: "print-fdm", exam });
    assert.equal(mapped.source, "recorded");
    assert.equal(mapped.simulated, true);
    assert.equal(mapped.recordedAt, "2026-11-09T21:40:00.000Z");
  });

  it("turns visible and hidden counts into one pass flag per check, passed first", () => {
    const mapped = examReplayOf({ recordedAt: null, simulated: false, task: "code", exam });
    assert.deepEqual(mapped.visible, [true, true, true, true, false]);
    assert.deepEqual(mapped.hidden, [true, true, false]);
  });

  it("gives empty flags when the counts are missing", () => {
    const mapped = examReplayOf({
      recordedAt: null,
      simulated: false,
      task: "code",
      exam: { id: "x", status: "ERROR", reasons: ["TESTS_MISSING"] },
    });
    assert.deepEqual(mapped.visible, []);
    assert.deepEqual(mapped.hidden, []);
    assert.equal(mapped.outcome, "ERROR");
    assert.deepEqual(mapped.reasons, ["TESTS_MISSING"]);
  });

  it("maps the night envelope's events and source", () => {
    const events = [{ at: "2026-11-09T22:14:00.000Z", kind: "bid" as const, title: "Bid", detail: "Floor price." }];
    const raw: RawNightReplay = { recordedAt: null, simulated: false, task: "code", night: { events } };
    const mapped = nightReplayOf(raw);
    assert.equal(mapped.source, "fixture");
    assert.deepEqual(mapped.events, events);
  });

  it("reads the shipped replay files with the mappers the screens use", () => {
    const code = examReplayOf(shipped("exam-code"));
    assert.equal(code.source, "fixture");
    assert.equal(code.outcome, "PASSED");
    assert.equal(code.visible.length, 5);
    assert.equal(code.hidden.length, 3);
    assert.ok(code.visible.every(Boolean) && code.hidden.every(Boolean));

    const print = examReplayOf(shipped("exam-print-fdm"));
    assert.equal(print.simulated, true);
    assert.equal(print.task, "print-fdm");
    assert.equal(print.visible.length, 5);
    assert.equal(print.hidden.length, 1);

    const night = nightReplayOf(shipped("night-code"));
    assert.equal(night.source, "fixture");
    assert.deepEqual(
      night.events.map((e) => e.kind),
      ["bid", "win", "money-held", "delivery", "verdict"],
    );
  });
});

describe("floor and morning mapping", () => {
  const record = { jobsTaken: 3, verified: 2, rejected: 1 };

  it("reads the floor's seeded flag from the top level", () => {
    const seeded = floorOf({ agentId: "agt_5", name: "Seeded", task: "code", grade: 55, record, earnedCents: 2000, seeded: true });
    assert.equal(seeded.seeded, true);
    const plain = floorOf({ agentId: "agt_6", name: "Plain", task: "code", grade: 45, record, earnedCents: 0 });
    assert.equal(plain.seeded, false);
  });

  it("reads the floor's simulated flag from the top level", () => {
    const simulated = floorOf({ agentId: "agt_7", name: "Sim", task: "code", grade: 50, record, earnedCents: 0, simulated: true });
    assert.equal(simulated.simulated, true);
    const plain = floorOf({ agentId: "agt_8", name: "Plain", task: "code", grade: 45, record, earnedCents: 0 });
    assert.equal(plain.simulated, false);
  });

  it("keeps the four payout fields the morning report reads", () => {
    const payout = { reference: "PAYOUT-SANDBOX-1", amountCents: 1000, jobId: "job_1", at: "2026-11-09T22:39:00.000Z", extra: "dropped" };
    const report = reportOf({
      since: "2026-11-09T20:00:00.000Z",
      sandbox: true,
      bids: [],
      wins: [],
      verified: [],
      rejected: [],
      payouts: [payout],
      gradeChanges: [{ at: "2026-11-09T22:39:00.000Z", agentId: "agt_1", delta: 5 }],
    });
    assert.deepEqual(report.payouts, [
      { reference: "PAYOUT-SANDBOX-1", amountCents: 1000, jobId: "job_1", at: "2026-11-09T22:39:00.000Z" },
    ]);
    assert.deepEqual(report.gradeChanges, [{ at: "2026-11-09T22:39:00.000Z", agentId: "agt_1", delta: 5 }]);
    assert.deepEqual(report.preApprovals, []);
  });

  it("fills missing entry fields with null", () => {
    const report = reportOf({
      since: "2026-11-09T20:00:00.000Z",
      sandbox: true,
      bids: [{ at: "2026-11-09T21:00:00.000Z" }],
      wins: [],
      verified: [],
      rejected: [],
      payouts: [],
      gradeChanges: [{ at: "2026-11-09T21:00:00.000Z", agentId: null, delta: -5 }],
      preApprovals: [{ at: "2026-11-09T21:05:00.000Z", jobId: "job_2", agentId: "agt_1", title: "Pre-approved" }],
    });
    assert.deepEqual(report.bids, [{ at: "2026-11-09T21:00:00.000Z", jobId: null, agentId: null, title: null }]);
    assert.deepEqual(report.gradeChanges, [{ at: "2026-11-09T21:00:00.000Z", agentId: null, delta: -5 }]);
    assert.deepEqual(report.preApprovals, [{ at: "2026-11-09T21:05:00.000Z", jobId: "job_2", agentId: "agt_1", title: "Pre-approved" }]);
  });
});
