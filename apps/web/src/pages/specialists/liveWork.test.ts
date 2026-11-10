import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { activityEvents, activityJobHref, activityLanes, activityStateWords, releasedWorkHref, runnerAction, runnerStatusWords, sampleActivityLabel, tallyWords } from "./liveWork.ts";
import type { ActivityState, OwnerActivity, ReleaseAuthority } from "./types.ts";

const example = JSON.parse(readFileSync(new URL("./__fixtures__/activity.example.json",import.meta.url),"utf8")) as OwnerActivity;
const released = example.activity[0]!;
const held = example.activity[1]!;

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
  assert.equal(runnerStatusWords(example.runner),"Waiting for a free runner");
  assert.equal(runnerStatusWords({...example.runner,status:"IDLE",reason:null}),"Nothing queued");
  assert.equal(runnerStatusWords({...example.runner,status:"RUNNING",reason:null}),"Sample runner is running");
  assert.equal(runnerStatusWords({...example.runner,status:"OFF",enabled:false,reason:null}),"Sample runner is off");
  for (const reason of ["NO_FORK","DAILY_LIMIT","NO_ACQUITTAL","NO_STANDING_ORDERS"] as const)
    assert.ok(runnerStatusWords({...example.runner,status:"REFUSED",reason}));
  assert.equal(activityLanes(example.activity,example.labels).length,2);
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
