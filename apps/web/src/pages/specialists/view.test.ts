import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runnerLabel } from "../../format.ts";
import {
  DEFAULT_FORM,
  STEPS,
  acquittedWords,
  countWords,
  autopilotCopy,
  examStartWords,
  examStatusWords,
  formFrom,
  formProblems,
  gateWords,
  gradeChangeWords,
  isExaminable,
  hasLiveExam,
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
  ownerAgent,
  checkLayout,
  recordWords,
  sinceIso,
  parsePrice,
  provenanceWords,
} from "./view.ts";
import type { StandingOrders } from "./types.ts";

describe("counted copy", () => {
  it("uses singular nouns for one and plural nouns for zero or several", () => {
    for (const noun of ["bid","job","agent","earlier event","earlier example event"]) {
      assert.equal(countWords(0,noun),`0 ${noun}s`);
      assert.equal(countWords(1,noun),`1 ${noun}`);
      assert.equal(countWords(2,noun),`2 ${noun}s`);
    }
    // Verified and rejected are adjectives: both remain unchanged with every count.
    for (const n of [0,1,2]) assert.equal(recordWords({jobsTaken:n,verified:n,rejected:n}),`${n} taken, ${n} verified, ${n} rejected`);
  });
});

describe("agent picking and the initial report window", () => {
  it("requires an explicit choice for several agents and never substitutes for a missing id", () => {
    const agents = [{ id: "a1" }, { id: "a2" }];
    assert.equal(pickAgent(agents, "a2")?.id, "a2");
    assert.equal(pickAgent(agents, "gone"), null);
    assert.equal(pickAgent(agents, undefined), null);
    assert.equal(pickAgent([agents[0]!], undefined)?.id, "a1");
    assert.equal(pickAgent([agents[0]!], "gone"), null);
    assert.equal(pickAgent([], undefined), null);
  });

  it("retains the selected agent, falls back to last-used or first, and never replaces an explicit missing id", () => {
    const agents = [{ id: "a1" }, { id: "a2" }];
    assert.equal(ownerAgent(agents, "a2", "a1")?.id, "a2");
    assert.equal(ownerAgent(agents, undefined, "a2")?.id, "a2");
    assert.equal(ownerAgent(agents, undefined, "gone")?.id, "a1");
    assert.equal(ownerAgent(agents)?.id, "a1");
    assert.equal(ownerAgent(agents, "gone", "a2"), null);
    assert.equal(ownerAgent([]), null);
  });

  it("uses an initial window before the account has a read cursor", () => {
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

  it("names each activity event kind and gives it a timeline tone", () => {
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
  it("uses one bar above eight visible checks and bounded icon rows for hidden counts", () => {
    for (const total of [9, 48, 1000]) assert.deepEqual(checkLayout(total, false), { segmented: true, rows: [] });
    for (const total of [0, 1, 5, 8, 49, 1000]) {
      const layout = checkLayout(total, true);
      assert.equal(layout.segmented, false);
      assert.ok(layout.rows.every((row) => row.length <= 4));
      assert.deepEqual(layout.rows.flat(), Array.from({ length: total }, (_, i) => i));
    }
    assert.deepEqual(checkLayout(8, false).rows.map((row) => row.length), [4, 4]);
    assert.deepEqual(checkLayout(8, true).rows.map((row) => row.length), [4, 4]);
  });
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
        [2, "Exam"],
        [3, "Orders"],
        [4, "Activity"],
        [5, "Earnings"],
      ],
    );
  });
});

describe("lenient orders prices and honest provenance", () => {
  it("accepts and normalises plain dollars and a currency prefix without losing cents", () => {
    for (const input of ["40", "$40", "40.00", "  $40.00  "]) {
      assert.equal(parsePrice(input), 4000);
      assert.equal(toOrdersInput({ ...DEFAULT_FORM, priceUsd: input }, "owner").priceFloorCents, 4000);
    }
    assert.equal(parsePrice("$0.01"), 1);
    for (const input of ["", "$", "4$0", "40.001", "-40", "1e3", "40,00"]) assert.equal(parsePrice(input), null);
    assert.ok(formProblems({ ...DEFAULT_FORM, priceUsd: "$0" }));
  });
  it("distinguishes sample data, recorded replay, simulation and seeded records", () => {
    assert.equal(provenanceWords("fixture", false), "Sample data");
    assert.equal(provenanceWords("recorded", false), "Replay of a recorded run");
    assert.equal(provenanceWords("recorded", true), "Replay of a recorded run · Simulated");
    assert.equal(provenanceWords(null, true), "Simulated");
    assert.equal(provenanceWords(null, false, true), "Seeded");
    assert.equal(provenanceWords(null, false), "");
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
  it("blocks print and laser before a start, even for a seeded acquittal", () => {
    for (const task of ["print-fdm", "laser-cut"] as const) {
      for (const acquitted of [false, true]) assert.equal(liveRunBlock(task, acquitted, null), "Exam coming.");
      assert.equal(hasLiveExam(task), false);
    }
    assert.equal(hasLiveExam("code"), true);
  });

  it("blocks acquitted agents and a missing verifier CI", () => {
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
    assert.equal(DEFAULT_FORM.priceUsd, "$40.00");
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
    assert.equal(form.priceUsd, "$40.50");
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

describe("earnings helpers", () => {
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
