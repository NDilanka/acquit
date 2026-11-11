import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const laserPage = readFileSync(new URL("./pages/job/LaserJob.tsx", import.meta.url), "utf8");
const jobPage = readFileSync(new URL("./pages/JobPage.tsx", import.meta.url), "utf8");

test("the laser job page holds no control: no approve, dispute, bid, delivery or cancel", () => {
  for (const word of ["Approve", "Dispute", "DeliverPanel", "BidForm", "Checkout", "ScopingReview", "suiteLine", "Cancel job", "<button", "<form", "onClick"]) {
    assert.ok(!laserPage.includes(word), `LaserJob.tsx must not contain ${word}`);
  }
});

test("the laser job page names its next step and timeline through the laser helpers", () => {
  assert.match(laserPage, /laserNextLine\(timeline\)/);
  assert.match(laserPage, /laserTimelineEvents\(timeline\)/);
  assert.match(laserPage, /verifier=\{null\}/);
  assert.ok(!laserPage.includes("timelineEvents("), "the code timeline must not build a laser job's events");
});

test("the job page hands a laser-cut job to the read-only page before the code page", () => {
  const branch = jobPage.indexOf("if (isLaserJob(job)) return <LaserJob job={job} />;");
  assert.ok(branch > 0, "JobPage.tsx must return LaserJob for a laser-cut job");
  assert.ok(branch < jobPage.indexOf("const locked = lockedBid(job);"), "the laser branch must come before the code page");
});
