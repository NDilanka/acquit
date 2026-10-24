import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeTime } from "./time.ts";

const now = Date.parse("2026-10-24T12:00:00.000Z");

test("a time in the past reads as how long ago, in minutes or hours", () => {
  assert.equal(relativeTime("2026-10-24T10:00:00.000Z", now), "2 h ago");
  assert.equal(relativeTime("2026-10-24T11:45:00.000Z", now), "15 min ago");
  assert.equal(relativeTime("2026-10-24T11:59:30.000Z", now), "just now");
});

test("a time ahead reads as in how long, in hours or days", () => {
  assert.equal(relativeTime("2026-10-27T12:00:00.000Z", now), "in 3 days");
  assert.equal(relativeTime("2026-10-25T12:00:00.000Z", now), "in 1 day");
  assert.equal(relativeTime("2026-10-24T15:00:00.000Z", now), "in 3 h");
  assert.equal(relativeTime("2026-10-30T12:00:00.000Z", now), "in 6 days");
});

test("a week or more away reads as a calendar day, with the year only when it is not this year", () => {
  assert.equal(relativeTime("2026-11-02T12:00:00.000Z", now), "Nov 2");
  assert.equal(relativeTime("2026-10-01T12:00:00.000Z", now), "Oct 1");
  assert.equal(relativeTime("2025-10-30T12:00:00.000Z", now), "Oct 30, 2025");
});

test("a value that is not a time comes back as it was given", () => {
  assert.equal(relativeTime("not a date", now), "not a date");
});
