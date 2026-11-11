import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { agentDelta, groupJobs, jobFacts, jobLanes, reportActivitySummary, reportEvents, stripRange, timeWords } from "./work.ts";
import type { MorningReport, OwnerActivity } from "./types.ts";
const report: MorningReport = { since: "2026-11-09T00:00:00Z", sandbox: true, bids: [], wins: [], verified: [], rejected: [], payouts: [], gradeChanges: [], preApprovals: [] };
test("Earnings names the exact job and uses only supplied bid and held amounts", () => {
  const data = {...report,bids:[{at:report.since,jobId:"j",agentId:"a",title:"Fix currency rounding",amountCents:4000}]};
  assert.deepEqual(jobFacts("j",data),{title:"Fix currency rounding",bidCents:4000,heldCents:null});
  assert.deepEqual(jobFacts("missing",data),{title:"Job missing",bidCents:null,heldCents:null});
  const example = JSON.parse(readFileSync(new URL("./__fixtures__/activity.example.json",import.meta.url),"utf8")) as OwnerActivity;
  const job = example.activity[0]!;
  const live: OwnerActivity = {...example,activity:[{...job,jobId:"j",title:"Stored live title",
    bid:{...job.bid!,priceCents:4011},moneyHeld:{...job.moneyHeld!,heldCents:4234}}]};
  assert.deepEqual(jobFacts("j",data,live),{title:"Stored live title",bidCents:4011,heldCents:4234});
  assert.equal(jobFacts("other",data,live).heldCents,null);
});
test("legacy Activity uses matching stored payouts without inventing a current job state", () => {
  const worked = {...report,verified:[{at:report.since,jobId:"mine",agentId:"a",title:null}]};
  assert.equal(reportActivitySummary(null,true,"a").heading,"Loading activity.");
  assert.equal(reportActivitySummary(report,true,"a").heading,"You can close this tab now.");
  assert.equal(reportActivitySummary(worked,true,"a").heading,"Your agent has work recorded.");
  const paid = {...worked,payouts:[{at:report.since,jobId:"mine",reference:"ref",amountCents:3638}]};
  assert.deepEqual(reportActivitySummary(paid,false,"a"),{heading:"Your agent was paid $36.38.",earnings:true,moneyLabel:"PayPal sandbox"});
  assert.equal(reportActivitySummary(paid,true,"other").heading,"You can close this tab now.");
  assert.equal(reportActivitySummary({...paid,bids:[{at:"2026-11-10T00:00:00Z",jobId:"new",agentId:"a",title:null}]},true,"a").heading,"Your agent has work recorded.");
});
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
test("only a payout for the same non-null job removes the unconfirmed-release warning", () => {
  const verified = ["paid","unpaid",null].map(jobId => ({at:report.since,jobId,agentId:"a",title:null}));
  const rows = reportEvents({...report,verified,payouts:[
    {at:report.since,jobId:"paid",reference:"paid-ref",amountCents:3638},
    {at:report.since,jobId:"unrelated",reference:"other-ref",amountCents:9999},
    {at:report.since,jobId:"",reference:"unscoped-ref",amountCents:123},
  ]});
  assert.equal(rows.find(row => row.jobId === "paid")?.status,"Verified");
  assert.equal(rows.find(row => row.jobId === "unpaid")?.status,"Verified · release not confirmed");
  assert.equal(rows.find(row => row.jobId === null)?.status,"Verified · release not confirmed");
  assert.ok(rows.every(row => row.kind === "verified"));
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
