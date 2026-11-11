import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { activityEvents, activityJobHref, activityLanes, activityStateWords, activitySteps, activitySummary, closedMoneyWords, closedReasonWords, MONEY_FLOW_WORDS, releasedWorkHref, runnerAction, runnerStatusWords, sampleActivityLabel, tallyWords } from "./liveWork.ts";
import type { ActivityState, OwnerActivity, ReleaseAuthority } from "./types.ts";

const example = JSON.parse(readFileSync(new URL("./__fixtures__/activity.example.json",import.meta.url),"utf8")) as OwnerActivity;
const released = example.activity[0]!;
const held = example.activity[1]!;

test("the four-step track uses each stored amount and time without fee arithmetic", () => {
  const job = {...released,bid:{...released.bid!,priceCents:4000},moneyHeld:{...released.moneyHeld!,heldCents:4200},
    attempts:[{...released.attempts[0]!,frozen:{passed:48,expected:48},hidden:{passed:8,expected:8}}],
    release:{...released.release!,payoutCents:3638}};
  const steps = activitySteps(job);
  assert.deepEqual(steps.map(step => step.title),["Bid placed $40.00","Money held $42.00","Verified","Released $36.38"]);
  assert.deepEqual(steps.map(step => step.at),[job.bid.placedAt,job.moneyHeld.heldAt,job.attempts[0]!.at,job.release.at]);
  assert.equal(steps[2]!.detail,"48 of 48 visible, 8 of 8 hidden");
  assert.equal(steps.some(step => step.current),false);
  assert.match(MONEY_FLOW_WORDS,/Acquit's fixed fee/);
  assert.match(MONEY_FLOW_WORDS,/PayPal's processing fee comes out of the held amount/);
  assert.doesNotMatch(MONEY_FLOW_WORDS,/\d|%|\$/);
});

test("live steps are marked by state, and absent verdicts, tallies and payouts are not invented", () => {
  const working = activitySteps(held);
  assert.equal(working.find(step => step.current)?.key,"held");
  assert.equal(working[2]!.at,null);
  assert.equal(working[2]!.detail,null);
  assert.equal(working[3]!.at,null);
  const checking = activitySteps({...held,state:"VERIFYING",attempts:[{...released.attempts[0]!,result:"REJECTED"}]});
  assert.equal(checking.find(step => step.current)?.title,"Verifying");
  assert.equal(checking[2]!.at,null);
  assert.equal(activitySteps({...released,release:{...released.release!,payoutCents:null}})[3]!.title,"Released");
  assert.equal(activitySteps({...held,state:"CLOSED"}).some(step => step.current),false);
});

test("Activity headlines distinguish no run, current work, a paid run and an unknown payout", () => {
  const idle = {...example,runner:{...example.runner,status:"IDLE" as const},activity:[]};
  assert.equal(activitySummary(undefined,true).heading,"Loading activity.");
  assert.equal(activitySummary(idle,true).heading,"You can close this tab now.");
  assert.equal(activitySummary(idle,false).heading,"Autopilot is off");
  const working = activitySummary({...idle,activity:[held]},true,held.agentId);
  assert.equal(working.heading,"Your agent is working on a job.");
  assert.equal(working.detail,activityStateWords(held.state));
  const paid = {...released,release:{...released.release!,payoutCents:3638}};
  const summary = activitySummary({...idle,activity:[paid]},false,paid.agentId);
  assert.equal(summary.heading,"Your agent was paid $36.38.");
  assert.equal(summary.detail,example.labels.money);
  assert.equal(summary.moneyLabel,example.labels.money);
  assert.equal(summary.earnings,true);
  assert.equal(activitySummary({...idle,activity:[{...paid,release:{...paid.release,payoutCents:null}}]},false).heading,"Your agent's payment was released.");
  assert.equal(activitySummary({...idle,activity:[{...paid,release:null}]},false).heading,"Your agent's payment was released.");
});

test("Activity uses the newest selected-agent job, not array order or another agent's payout", () => {
  const old = {...released,agentId:"mine",updatedAt:"2026-11-09T01:00:00Z"};
  const current = {...held,agentId:"mine",updatedAt:"2026-11-10T01:00:00Z"};
  const other = {...released,agentId:"other",updatedAt:"2026-11-11T01:00:00Z"};
  for (const activity of [[old,other,current],[current,old,other]])
    assert.equal(activitySummary({...example,activity},true,"mine").heading,"Your agent is working on a job.");
  assert.equal(activitySummary({...example,activity:[other]},true,"mine").heading,"You can close this tab now.");
  const running = activitySummary({...example,runner:{...example.runner,status:"RUNNING"},activity:[other]},true,"mine");
  assert.equal(running.heading,"The sample runner is running.");
  assert.equal(running.detail,"No job has been recorded for this agent yet.");
});

test("closed and refused headlines use safe reasons while a paid run survives autopilot being off", () => {
  const stopped = {...held,state:"CLOSED" as const,closedReason:"verifier gave no verdict in 3 runs"};
  const summary = activitySummary({...example,activity:[stopped]},true);
  assert.equal(summary.heading,"The verifier returned no verdict for this delivery.");
  assert.match(summary.detail,/Money is still held/);
  const refused = {...example,runner:{...example.runner,status:"REFUSED" as const,reason:"BID_DENIED"},activity:[]};
  assert.equal(activitySummary(refused,true).heading,"The client declined this bid");
  assert.equal(activitySummary({...refused,runner:{...refused.runner,reason:"AUTOPILOT_OFF"},activity:[released]},false).earnings,true);
  assert.equal(activitySummary({...example,activity:[{...held,state:"REFUNDED"}]},false).heading,"The payment was refunded.");
});

test("the contract example displays exact stored times, gross held money and net released money", () => {
  const events = activityEvents(released,example.labels);
  assert.deepEqual(events.map(event => event.at),[released.bid!.placedAt,released.moneyHeld!.heldAt,released.attempts[0]!.at,released.release!.at]);
  assert.match(events[0]!.title,/\$400.00 pending · PayPal sandbox/);
  assert.match(events[1]!.title,/Money held · \$400.00 held/);
  assert.match(events[2]!.title,/Attempt 1 · Verified · Real verifier run/);
  assert.deepEqual(events[2]!.details,["Frozen 6 of 6","Hidden 9 of 9"]);
  assert.match(events[3]!.title,/\$370.00 released · PayPal sandbox/);
  assert.deepEqual(events[3]!.details,["Client approval"]);
  assert.equal(events.some(event => /accepted/i.test(event.title)),false);
});

test("current job steps come from state, never the presence of an attempt or release", () => {
  const states: ActivityState[] = ["BID_PLACED","FUNDING","MONEY_HELD","RETRYING","VERIFYING","REFUNDING","AWAITING_APPROVAL","DISPUTED","RELEASING","RELEASED","REFUNDED","CLOSED"];
  for (const state of states) {
    const lanes = activityLanes([{...released,state}],example.labels);
    assert.ok(lanes[0]!.label.endsWith(activityStateWords(state)));
    assert.equal(lanes[0]!.tone === "ok",state === "RELEASED");
  }
  assert.match(activityStateWords("AWAITING_APPROVAL"),/awaiting client approval/);
});

test("only runner-marked simulated jobs carry the exact sample label", () => {
  assert.equal(sampleActivityLabel(released),"Sample agent · Simulated");
  assert.equal(sampleActivityLabel(held),null);
  assert.equal(sampleActivityLabel({...released,source:"OWNER"}),null);
  assert.equal(sampleActivityLabel({...released,simulated:false}),null);
});

test("absent tallies and releases are omitted, not made up as zero", () => {
  assert.deepEqual(tallyWords("Hidden",null),[]);
  const events = activityEvents(held,example.labels);
  assert.equal(events.length,2);
  assert.equal(events.some(event => /released|verified/i.test(event.title)),false);
  assert.equal(activityEvents({...released,release:{...released.release!,payoutCents:null}},example.labels).at(-1)?.title,"Payment released · PayPal sandbox");
});

test("all stored release authorities remain separate from verification", () => {
  const authorities: ReleaseAuthority[] = ["CLIENT_APPROVAL","REVIEW_SILENCE","ARBITER_UPHELD","ARBITER_SLA_MISSED","CAPTURE_CUTOFF"];
  const descriptions = authorities.map(authority => activityEvents({...released,release:{...released.release!,authority}},example.labels).at(-1)!.details[0]);
  assert.equal(new Set(descriptions).size,5);
  assert.ok(descriptions.every(Boolean));
});

test("queued, idle, running, off and refusal states have plain text, not fake job events", () => {
  assert.equal(runnerStatusWords(example.runner),"The sample is waiting for a free runner.");
  assert.equal(runnerStatusWords({...example.runner,status:"IDLE",reason:null}),"No sample run is queued.");
  assert.equal(runnerStatusWords({...example.runner,status:"RUNNING",reason:null}),"The sample runner is running.");
  assert.equal(runnerStatusWords({...example.runner,status:"OFF",enabled:false,reason:null}),"The sample runner is off.");
  for (const reason of ["NO_FORK","DAILY_LIMIT","NO_ACQUITTAL","NO_STANDING_ORDERS"] as const)
    assert.ok(runnerStatusWords({...example.runner,status:"REFUSED",reason}));
  assert.equal(activityLanes(example.activity,example.labels).length,2);
});

test("every refusal and unknown state has safe sentence copy", () => {
  for (const reason of ["AUTOPILOT_OFF","NOT_HOSTED","NOT_A_SAMPLE","BID_DENIED","PRICE_CANNOT_CARRY_FEE","DELIVERY_STOPPED","NO_STANDING_ORDERS","NO_FORK","NO_ACQUITTAL","DAILY_LIMIT"]) {
    const words=runnerStatusWords({...example.runner,status:"REFUSED",reason});
    assert.ok(words.length>10);
    assert.ok(!words.includes(reason));
  }
  for (const state of ["UNKNOWN","toString","__proto__"]) assert.equal(activityStateWords(state),"The current job state is unavailable.");
  assert.equal(runnerStatusWords({...example.runner,status:"FUTURE" as OwnerActivity["runner"]["status"]}),"The sample runner's current state is unavailable.");
});

test("closed delivery preserves held money without promising a refund or inventing a deadline", () => {
  const stopped={...held,state:"CLOSED" as const,closedReason:"verifier gave no verdict in 3 runs"};
  assert.equal(closedReasonWords(stopped.closedReason),"The verifier returned no verdict for this delivery.");
  assert.equal(closedReasonWords("job is IN_PROGRESS with no verdict for this commit"),"The verifier returned no verdict for this delivery.");
  assert.match(closedMoneyWords(stopped)!,/Money is still held/);
  assert.equal(activityEvents(stopped,example.labels).length,2);
  assert.equal(closedMoneyWords({...stopped,moneyHeld:null}),null);
  assert.equal(closedReasonWords(null),null);
  for(const reason of ["job is CLOSED","job is no longer listed","run has no commit","push failed (PrivateError)","submit denied: NOT_OWNER","unknown private payload"]) {
    const words=closedReasonWords(reason)!;
    assert.ok(words.endsWith("."));
    assert.ok(!words.includes("PrivateError")&&!words.includes("NOT_OWNER")&&!words.includes("private payload"));
  }
});

test("earnings links a matching job back to the live entry, otherwise keeps the job link", () => {
  assert.equal(releasedWorkHref(released.jobId,example),activityJobHref(released.jobId));
  assert.equal(releasedWorkHref(released.jobId,null),`/jobs/${released.jobId}`);
  assert.equal(releasedWorkHref("missing",example),"/jobs/missing");
});

test("refusals name the owner action without treating a declined bid as an agent failure", () => {
  const refused = (reason: string) => ({...example.runner,status:"REFUSED" as const,reason});
  assert.equal(runnerStatusWords(refused("BID_DENIED")),"The client declined this bid");
  assert.equal(runnerAction(refused("BID_DENIED")),null);
  assert.equal(runnerStatusWords(refused("PRICE_CANNOT_CARRY_FEE")),"Your price floor is too low to cover PayPal's fee. Raise it in Standing orders.");
  for (const reason of ["NO_STANDING_ORDERS","AUTOPILOT_OFF","NOT_HOSTED","PRICE_CANNOT_CARRY_FEE"])
    assert.equal(runnerAction(refused(reason),"agent / code")?.to,"/specialists/orders/agent%20%2F%20code");
  assert.equal(runnerAction(refused("NO_ACQUITTAL"))?.to,"/specialists/exam");
  assert.equal(runnerAction(refused("NOT_A_SAMPLE"))?.to,"/specialists");
  assert.equal(runnerStatusWords(refused("NEW_REASON")),"The sample runner is unavailable for this agent.");
  assert.equal(runnerAction(refused("NEW_REASON")),null);
  assert.equal(runnerAction(example.runner),null);
});

test("reason summaries never expose a hidden test suffix", () => {
  const attempt = {...released.attempts[0]!,result:"REJECTED",reasons:["TESTS_FAILED:hidden"]};
  const events = activityEvents({...released,attempts:[attempt]},example.labels);
  assert.equal(events[2]!.rejected,true);
  assert.ok(events[2]!.details.includes("Some checks did not pass."));
  assert.equal(events[2]!.details.some(detail => detail.includes("TESTS_FAILED:hidden")),false);
});
