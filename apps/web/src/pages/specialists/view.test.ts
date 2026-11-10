import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runnerLabel } from "../../format.ts";
import {
  DEFAULT_FORM,
  STEPS,
  acquittedWords,
  autopilotCopy,
  examStartWords,
  examStatusWords,
  formFrom,
  formProblems,
  gateWords,
  gradeChangeWords,
  isExaminable,
  liveRunBlock,
  runnerWords,
  ordersDirty,
  paidTotalCents,
  reasonSentence,
  reasonSentences,
  replayLabel,
  simulatedNote,
  taskLabel,
  toOrdersInput,
  EXAM_SHAPE,
  SIMULATED_WORD,
  START_GRADE,
  entryTitle,
  nightKindWords,
  nightTone,
  pickAgent,
  recordWords,
  sinceIso,
} from "./view.ts";
import type { StandingOrders } from "./types.ts";

describe("agent picking and the morning window", () => {
  it("picks the named agent, else the first one", () => {
    const agents = [{ id: "a1" }, { id: "a2" }];
    assert.equal(pickAgent(agents, "a2")?.id, "a2");
    assert.equal(pickAgent(agents, "gone")?.id, "a1");
    assert.equal(pickAgent(agents, undefined)?.id, "a1");
    assert.equal(pickAgent([], undefined), null);
  });

  it("reads the morning report from the last 24 hours", () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    assert.equal(sinceIso(now), "2026-11-09T12:00:00.000Z");
  });
});

describe("report lines and records", () => {
  it("titles a report line from its title, its job, or the fallback", () => {
    assert.equal(entryTitle({ at: "t", jobId: "job_1", agentId: null, title: "Fixed the tests" }, "Bid"), "Fixed the tests");
    assert.equal(entryTitle({ at: "t", jobId: "job_1", agentId: null, title: null }, "Bid"), "Job job_1");
    assert.equal(entryTitle({ at: "t", jobId: null, agentId: null, title: null }, "Bid"), "Bid");
  });

  it("writes a track record in one line", () => {
    assert.equal(recordWords({ jobsTaken: 3, verified: 2, rejected: 1 }), "3 taken, 2 verified, 1 rejected");
  });

  it("names each night event kind and gives it a timeline tone", () => {
    assert.deepEqual(
      (["bid", "win", "money-held", "delivery", "verdict"] as const).map((k) => [nightKindWords(k), nightTone(k)]),
      [
        ["Bid", "open"],
        ["Won", "ok"],
        ["Money held", "held"],
        ["Delivered", "open"],
        ["Verdict", "ok"],
      ],
    );
  });
});

describe("exam shape", () => {
  it("draws the same number of checks the samples report", () => {
    assert.deepEqual(EXAM_SHAPE.code, { visible: 5, hidden: 3 });
    assert.deepEqual(EXAM_SHAPE["print-fdm"], { visible: 5, hidden: 1 });
    assert.deepEqual(EXAM_SHAPE["laser-cut"], { visible: 0, hidden: 0 });
    assert.equal(START_GRADE, 50);
  });
});

describe("steps", () => {
  it("numbers the five screens in order", () => {
    assert.deepEqual(
      STEPS.map((s) => [s.step, s.label]),
      [
        [1, "Plug in"],
        [2, "The exam"],
        [3, "Standing orders"],
        [4, "The night"],
        [5, "The morning"],
      ],
    );
  });
});

describe("honest labels", () => {
  it("uses only the agreed status words", () => {
    assert.equal(acquittedWords(true), "Acquitted");
    assert.equal(acquittedWords(false), "not acquitted");
  });

  it("marks simulated machines and never claims hardware", () => {
    assert.equal(simulatedNote("print-fdm"), "Simulated · No real hardware");
    assert.equal(simulatedNote("laser-cut"), "Simulated · coming");
    assert.equal(simulatedNote("code"), null);
  });

  it("labels a simulated acquittal or run Simulated", () => {
    assert.equal(SIMULATED_WORD, "Simulated");
  });

  it("says sample data until a run is recorded", () => {
    assert.equal(replayLabel("fixture"), "Sample data");
    assert.equal(replayLabel("recorded"), "Replay of a recorded run");
  });

  it("keeps the banned words out of the status copy", () => {
    const copy = [acquittedWords(true), acquittedWords(false), taskLabel("code"), taskLabel("print-fdm"), taskLabel("laser-cut")];
    for (const word of ["cleared", "licensed", "certified"]) {
      for (const line of copy) assert.equal(line.toLowerCase().includes(word), false, `${word} in ${line}`);
    }
  });

  it("maps exam statuses to the page's words", () => {
    assert.equal(examStatusWords("PASSED"), "Acquitted");
    assert.equal(examStatusWords("FAILED"), "not acquitted");
    assert.equal(examStatusWords("RUNNING"), "Running");
  });
});

describe("bid gate words", () => {
  it("says open, or names why the gate is closed", () => {
    assert.equal(gateWords("OPEN"), "Open");
    assert.equal(gateWords("NOT_ACQUITTED"), "Closed: not acquitted");
    assert.equal(gateWords("WRONG_TASK"), "Closed: only code work passes");
  });

  it("keeps the banned words out of the gate copy", () => {
    for (const gate of ["OPEN", "NOT_ACQUITTED", "WRONG_TASK"] as const) {
      for (const word of ["cleared", "licensed", "certified"]) {
        assert.equal(gateWords(gate).toLowerCase().includes(word), false, `${word} in ${gate}`);
      }
    }
  });
});

describe("exam reasons", () => {
  it("turns each known kind into one sentence", () => {
    assert.equal(reasonSentence("TESTS_FAILED"), "Some checks did not pass.");
    assert.equal(reasonSentence("TESTS_MISSING"), "Some checks did not run.");
  });

  it("reads an unknown kind generically and never shows the kind", () => {
    const text = reasonSentence("SOMETHING_NEW");
    assert.equal(text.includes("SOMETHING_NEW"), false);
    assert.ok(text.length > 0);
  });

  it("drops repeated sentences", () => {
    assert.deepEqual(reasonSentences(["TESTS_FAILED", "TESTS_FAILED"]), ["Some checks did not pass."]);
    assert.deepEqual(reasonSentences([]), []);
  });
});

describe("live run gate", () => {
  it("blocks laser cut, acquitted agents and a missing verifier CI", () => {
    assert.equal(liveRunBlock("laser-cut", false, null), "Exam coming.");
    assert.match(liveRunBlock("code", true, null) ?? "", /already Acquitted/);
    assert.match(liveRunBlock("code", false, "VERIFIER_CI_NOT_CONFIGURED") ?? "", /CI is not set up/);
  });

  it("blocks a live run when exams are not built yet", () => {
    assert.equal(liveRunBlock("code", false, "EXAM_NOT_BUILT"), "Exam coming.");
    assert.equal(liveRunBlock("print-fdm", false, "EXAM_NOT_BUILT"), "Exam coming.");
  });

  it("blocks a live run the API will not examine", () => {
    assert.equal(liveRunBlock("code", false, "TASK_NOT_EXAMINABLE"), "Exam coming.");
  });

  it("allows a live run otherwise", () => {
    assert.equal(liveRunBlock("code", false, null), null);
    assert.equal(liveRunBlock("print-fdm", false, null), null);
  });

  it("leaves other start refusals to show as errors, not as a block", () => {
    assert.equal(liveRunBlock("code", false, "EXAM_LIMIT"), null);
  });

  it("only lets laser cut skip the exam", () => {
    assert.equal(isExaminable("code"), true);
    assert.equal(isExaminable("print-fdm"), true);
    assert.equal(isExaminable("laser-cut"), false);
  });

  it("names the simulated runners the API sends", () => {
    assert.equal(runnerWords("simulated-fdm"), "Simulated runner");
    assert.equal(runnerWords("simulated-laser"), "Simulated runner");
    assert.equal(runnerWords("claude-code"), runnerLabel("claude-code"));
  });

  it("names the start refusals the page turns into words", () => {
    assert.match(examStartWords("VERIFIER_CI_NOT_CONFIGURED") ?? "", /CI is not set up/);
    assert.equal(examStartWords("EXAM_NOT_BUILT"), "Exam coming.");
    assert.equal(examStartWords("TASK_NOT_EXAMINABLE"), "Exam coming.");
    assert.equal(examStartWords("EXAM_LIMIT"), null);
  });
});

describe("standing orders form", () => {
  it("starts from the defaults when nothing is saved", () => {
    assert.deepEqual(formFrom(null), DEFAULT_FORM);
    assert.equal(DEFAULT_FORM.preApproveCap, 3);
  });

  it("reads a saved price as dollars", () => {
    const form = formFrom({
      priceFloorCents: 4050,
      maxConcurrent: 2,
      autopilot: true,
      runsOn: "owner",
      preApprove: true,
      preApproveCap: 2,
      updatedAt: "2026-11-10T18:00:00Z",
    });
    assert.equal(form.priceUsd, "40.50");
    assert.equal(form.maxConcurrent, 2);
    assert.equal(form.autopilot, true);
  });

  it("rejects a blank, zero or unreadable price", () => {
    assert.ok(formProblems({ ...DEFAULT_FORM, priceUsd: "" }));
    assert.ok(formProblems({ ...DEFAULT_FORM, priceUsd: "0" }));
    assert.ok(formProblems({ ...DEFAULT_FORM, priceUsd: "forty" }));
    assert.equal(formProblems(DEFAULT_FORM), null);
  });

  it("sends pre-approval only with autopilot on", () => {
    const off = toOrdersInput({ ...DEFAULT_FORM, autopilot: false }, "owner");
    assert.equal(off.preApprove, false);
    assert.equal(off.autopilot, false);
    const on = toOrdersInput({ ...DEFAULT_FORM, priceUsd: "40.00", autopilot: true, preApproveCap: 2 }, "acquit");
    assert.equal(on.priceFloorCents, 4000);
    assert.equal(on.preApprove, true);
    assert.equal(on.preApproveCap, 2);
    assert.equal(on.runsOn, "acquit");
  });
});

describe("autopilot copy", () => {
  it("says the agent acts alone up to the cap, then that the tab can close", () => {
    assert.deepEqual(autopilotCopy(true, 3), [
      "With autopilot on, your agent bids, delivers and collects on its own, up to 3 submits a day.",
      "You can close this tab now.",
    ]);
  });

  it("says each submit needs the owner when off", () => {
    assert.deepEqual(autopilotCopy(false, 3), ["Each submit needs the owner's confirmation."]);
  });
});

describe("morning report helpers", () => {
  it("adds up payouts in cents", () => {
    assert.equal(paidTotalCents([{ amountCents: 4500 }, { amountCents: 500 }]), 5000);
    assert.equal(paidTotalCents([]), 0);
  });

  it("writes a grade change as a signed step", () => {
    assert.equal(gradeChangeWords(5), "+5");
    assert.equal(gradeChangeWords(-5), "−5");
    assert.equal(gradeChangeWords(0), "0");
  });
});

describe("standing orders dirty check", () => {
  const saved: StandingOrders = {
    priceFloorCents: 4000,
    maxConcurrent: 2,
    autopilot: true,
    runsOn: "acquit",
    preApprove: true,
    preApproveCap: 2,
    updatedAt: "2026-11-10T09:00:00.000Z",
  };
  const form = formFrom(saved);

  it("is clean when the form matches the saved orders", () => {
    assert.equal(ordersDirty(form, saved), false);
    assert.equal(ordersDirty(formFrom(saved), saved), false);
  });

  it("treats a price typed another way as the same price", () => {
    assert.equal(ordersDirty({ ...form, priceUsd: "40" }, saved), false);
    assert.equal(ordersDirty({ ...form, priceUsd: "40.00" }, saved), false);
  });

  it("is dirty when the price, jobs at a time, cap or autopilot change", () => {
    assert.equal(ordersDirty({ ...form, priceUsd: "40.01" }, saved), true);
    assert.equal(ordersDirty({ ...form, maxConcurrent: 3 }, saved), true);
    assert.equal(ordersDirty({ ...form, preApproveCap: 1 }, saved), true);
    assert.equal(ordersDirty({ ...form, autopilot: false }, saved), true);
  });

  it("is dirty when nothing is saved yet", () => {
    assert.equal(ordersDirty(DEFAULT_FORM, null), true);
  });
});
