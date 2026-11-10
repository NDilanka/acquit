import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDelta, groupJobs, jobLanes, reportEvents, stripRange, timeWords } from "./work.ts";
import type { MorningReport } from "./types.ts";
const report: MorningReport = { since: "2026-11-09T00:00:00Z", sandbox: true, bids: [], wins: [], verified: [], rejected: [], payouts: [], gradeChanges: [], preApprovals: [] };
test("selected agent events never acquire workspace payouts or null-agent events", () => {
  const rows = reportEvents({ ...report, bids: [{ at: report.since, jobId: "job_a", agentId: "a", title: null, amountCents: 1200 },
    { at: report.since, jobId: "job_b", agentId: null, title: null }],
    payouts: [{ at: report.since, jobId: "job_b", reference: "ref", amountCents: 9999 }] }).filter(e => e.agentId === "a");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "$12.00 pending");
});
test("verification is not payment release", () => {
  const rows = reportEvents({ ...report, verified: [{ at: report.since, jobId: "a", agentId: "x", title: null }] });
  assert.equal(rows[0]?.status, "Verified · release not confirmed");
  assert.equal(jobLanes(rows)[0]?.tone, "open");
});
test("jobs sort newest first, unrelated null jobs remain separate", () => {
  const rows = reportEvents({ ...report, bids: [0, 1].map(i => ({ at: `2026-11-09T0${i}:00:00Z`, jobId: null, agentId: "a", title: null })) });
  assert.equal(groupJobs(rows).length, 2);
  assert.equal(rows[0]?.at, "2026-11-09T01:00:00Z");
});
test("strip range uses the real timestamps even for one instant", () => {
  const lanes = [{ id: "a", label: "a", start: report.since, end: report.since, tone: "open" as const }];
  const range = stripRange(lanes)!;
  assert.equal(range.start, range.end);
  assert.equal(range.span, 1);
  assert.equal(stripRange([]), null);
});
test("delta sums signed values for only the selected agent", () => {
  assert.equal(agentDelta({ ...report, gradeChanges: [{ at: report.since, agentId: "a", delta: 5 }, { at: report.since, agentId: "a", delta: -10 }, { at: report.since, agentId: "b", delta: 90 }] }, "a"), -5);
  assert.equal(agentDelta(null, "a"), undefined);
});
test("timestamps use lowercase twelve-hour clock", () => {
  assert.match(timeWords(report.since), /\d{1,2}:\d{2} (?:am|pm)$/);
});
