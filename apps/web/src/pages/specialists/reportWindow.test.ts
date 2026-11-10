import assert from "node:assert/strict";
import { test } from "node:test";
import { quietReportEnd, windowedReport } from "./reportWindow.ts";
import type { MorningReport } from "./types.ts";
const empty: MorningReport = { since:"1970-01-01T00:00:00Z",sandbox:true,bids:[],wins:[],verified:[],rejected:[],payouts:[],gradeChanges:[],preApprovals:[] };
test("quiet views share a fixed 24-hour window per owner and UTC day", () => {
  const values = new Map<string,string>();
  const store = { getItem:(key:string) => values.get(key) ?? null,setItem:(key:string,value:string) => { values.set(key,value); } };
  const first = quietReportEnd(store,"owner","2026-11-10T10:09:00.000Z");
  assert.equal(quietReportEnd(store,"owner","2026-11-10T22:09:00.000Z"),first);
  assert.equal(windowedReport(empty,first).data.since,"2026-11-09T10:09:00.000Z");
  assert.equal(quietReportEnd(store,"other","2026-11-10T22:09:00.000Z"),"2026-11-10T22:09:00.000Z");
  assert.equal(quietReportEnd(store,"owner","2026-11-11T01:00:00.000Z"),"2026-11-11T01:00:00.000Z");
});
test("stored work, not the next page view, anchors the last report with work", () => {
  const raw = { ...empty,bids:["2026-11-01T00:00:00Z","2026-11-09T18:00:00Z"].map(at => ({ at,jobId:"j",agentId:"a",title:null })),
    payouts:[{ at:"2026-11-10T18:00:00Z",jobId:"j",amountCents:37000,reference:"real" }] };
  const first = windowedReport(raw,"2026-11-11T00:00:00Z");
  assert.deepEqual(windowedReport(raw,"2026-11-15T00:00:00Z"),first);
  assert.equal(first.data.bids.length,1);
  assert.equal(first.through,"2026-11-10T18:00:00.000Z");
  assert.equal(first.data.payouts[0]?.amountCents,37000);
});
test("all supplied event kinds, including grade changes, can advance the work window", () => {
  const last = "2026-11-10T23:00:00Z";
  assert.equal(windowedReport({ ...empty,gradeChanges:[{ at:last,agentId:"a",delta:5 }] },"2026-11-11T00:00:00Z").through,"2026-11-10T23:00:00.000Z");
});
