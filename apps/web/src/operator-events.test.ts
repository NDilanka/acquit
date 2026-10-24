import assert from "node:assert/strict";
import { test } from "node:test";
import type { BidView, JobView } from "./api-types";
import { deliveryCount, operatorEvents, readSeen, unseenEvents, writeSeen } from "./operator-events.ts";

const ME = "teal-otter-ops";

function bid(over: Partial<BidView> = {}): BidView {
  return { id: "bid_1", operator: "op_me", handle: ME, label: "INDEPENDENT", price: 40000, eta: 24, agent: "agent_1", runner: "acquit",
    pitch: "", paidReceipts: 0, houseLine: null, status: "PENDING", ...over };
}

type Watched = Parameters<typeof operatorEvents>[0][number];

function job(over: Partial<JobView> = {}): Watched {
  return { id: "job_1", title: "Totals round wrong for JPY", status: "OPEN", phase: "BIDDING", bids: { operators: [bid()], house: null },
    lockedTo: null, receipt: null, release: null, ...over };
}

const won = job({ status: "IN_PROGRESS", phase: "READY", lockedTo: "op_me", bids: { operators: [bid({ status: "ACCEPTED" })], house: null } });
const paid = job({ status: "PAID", phase: "PAID", lockedTo: "op_me", bids: { operators: [bid({ status: "ACCEPTED" })], house: null },
  release: { payoutItemId: "PI1", captureId: "C1", paid: 36000, at: "2026-10-24T10:00:00.000Z" } });

test("a won bid and a released payment are the operator's two moments, named with the job's title", () => {
  assert.deepEqual(operatorEvents([job()], ME), []);
  assert.deepEqual(operatorEvents([won], ME), [{ key: "accepted:job_1", message: "Your bid on “Totals round wrong for JPY” was accepted." }]);
  assert.deepEqual(operatorEvents([paid], ME).map((event) => event.message),
    ["Your bid on “Totals round wrong for JPY” was accepted.", "You were paid 360.00 USD for “Totals round wrong for JPY”."]);
  // Another operator's win is not this operator's moment.
  assert.deepEqual(operatorEvents([won], "someone-else-ops"), []);
});

test("an event shows once: a first watch marks what is already true, and a stored key is never toasted again", () => {
  const first = unseenEvents(operatorEvents([won], ME), null);
  assert.deepEqual(first, { fresh: [], seen: ["accepted:job_1"] });
  const later = unseenEvents(operatorEvents([paid], ME), first.seen);
  assert.deepEqual(later.fresh.map((event) => event.key), ["paid:job_1"]);
  assert.deepEqual(unseenEvents(operatorEvents([paid], ME), later.seen).fresh, []);
  const empty = unseenEvents([], null);
  assert.deepEqual(unseenEvents(operatorEvents([won], ME), empty.seen).fresh.map((event) => event.key), ["accepted:job_1"]);
});

test("the seen keys survive a reload through storage, and a broken store reads as never watched", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  assert.equal(readSeen(store, ME), null);
  writeSeen(store, ME, ["accepted:job_1"]);
  assert.deepEqual(readSeen(store, ME), ["accepted:job_1"]);
  values.set(`acquit.seenEvents.${ME}`, "{not json");
  assert.equal(readSeen(store, ME), null);
});

test("the My work badge counts the jobs locked to the operator that wait on a delivery", () => {
  assert.equal(deliveryCount([won, paid, job()], ME), 1);
  assert.equal(deliveryCount([won], "someone-else-ops"), 0);
});
