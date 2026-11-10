import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTaskLabel, autopilotIsOn, completedSetup, reportWorkDates, workAgent } from "./ownerState.ts";
import type { MorningReport, SpecialistAgent, StandingOrders } from "./types.ts";

const orders: StandingOrders = { priceFloorCents:4000,maxConcurrent:2,autopilot:true,runsOn:"acquit",preApprove:true,preApproveCap:2,updatedAt:"2026-11-10T18:00:00Z" };
const code: SpecialistAgent = { id:"code",name:"Code fixer",task:"code",runner:"claude-code",sample:"code-fixer",acquitted:true,grade:50,seeded:false,simulated:true };
const print: SpecialistAgent = { ...code,id:"print",task:"print-fdm",runner:"simulated-fdm" };

test("setup ticks use acknowledgements, not a visited screen, including seeded and unpassed agents", () => {
  assert.deepEqual([...completedSetup(null, orders)], []);
  assert.deepEqual([...completedSetup(code, null)], [1,2]);
  assert.deepEqual([...completedSetup(code, orders)], [1,2,3]);
  assert.deepEqual([...completedSetup({ ...code,acquitted:false }, orders)], [1]);
  assert.deepEqual([...completedSetup({ ...code,seeded:true }, null)], [1]);
  assert.deepEqual([...completedSetup(print, orders)], [1]);
});

test("simulated hardware is named explicitly and never treated as autonomous code work", () => {
  assert.equal(agentTaskLabel("print-fdm"), "Simulated 3D print");
  assert.equal(agentTaskLabel("laser-cut"), "Simulated Laser cut");
  assert.equal(autopilotIsOn(print, orders), false);
  assert.equal(autopilotIsOn({ ...code,acquitted:false }, orders), false);
  assert.equal(autopilotIsOn(code, { ...orders,autopilot:false }), false);
  assert.equal(autopilotIsOn(code, orders), true);
});

test("the most recently working Acquitted code agent wins over newer plugs and newer acquittals", () => {
  const newer = { ...code,id:"newer",acquittedAt:"2026-11-10T18:05:00Z" };
  assert.equal(workAgent([print,newer,code], [{agentId:"code",at:"2026-11-10T18:04:40Z"}])?.id, "code");
  assert.equal(workAgent([print,code,newer], [])?.id, "newer");
  assert.equal(workAgent([print,code], [{agentId:"print",at:"2026-11-10T18:05:00Z"}])?.id, "code");
  assert.equal(workAgent([], []), null);
});

test("release recency never attributes a payout to an unsuccessful bidder", () => {
  const report: MorningReport = { since:"1970-01-01T00:00:00Z",sandbox:true,bids:[{jobId:"j",agentId:"code",at:"2026-11-10T18:00:00Z",title:null}],wins:[],verified:[],rejected:[],preApprovals:[],gradeChanges:[],payouts:[{jobId:"j",at:"2026-11-10T18:04:40Z",amountCents:37000,reference:"p"}] };
  assert.equal(reportWorkDates(report).length, 1);
  assert.equal(reportWorkDates({ ...report,wins:report.bids }).at(-1)?.at, "2026-11-10T18:04:40Z");
});
