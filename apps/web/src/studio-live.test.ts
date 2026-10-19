import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOK_EMPTY,
  bookRead,
  clockTime,
  freshnessNotice,
  isStale,
  onChange,
  onSettled,
  parseStreamEvent,
  READ_IDLE,
  type ReadState,
} from "./studio/live.ts";

test("a change line parses to its kind and time, and anything else is refused", () => {
  assert.deepEqual(parseStreamEvent('{"kind":"changed","at":"2026-10-13T12:00:00.000Z"}'),
    { kind: "changed", at: "2026-10-13T12:00:00.000Z" });
  assert.equal(parseStreamEvent('{"kind":"tables","at":"2026-10-13T12:00:00.000Z"}'), null);
  assert.equal(parseStreamEvent('{"kind":"changed"}'), null);
  assert.equal(parseStreamEvent('{"kind":"changed","at":1781352000000}'), null);
  assert.equal(parseStreamEvent("null"), null);
  assert.equal(parseStreamEvent('"changed"'), null);
  assert.equal(parseStreamEvent("not json"), null);
});

test("an idle change starts a read; a change during a read queues exactly one more", () => {
  const first = onChange(READ_IDLE);
  assert.deepEqual(first, { state: { reading: true, again: false }, read: true });

  const during = onChange(first.state);
  assert.deepEqual(during, { state: { reading: true, again: true }, read: false });

  // A second change during the same read queues nothing more.
  assert.deepEqual(onChange(during.state), { state: { reading: true, again: true }, read: false });
});

test("a settled read runs the queued read, and an idle settle goes idle", () => {
  const queued: ReadState = { reading: true, again: true };
  assert.deepEqual(onSettled(queued), { state: { reading: true, again: false }, read: true });
  assert.deepEqual(onSettled({ reading: true, again: false }), { state: READ_IDLE, read: false });
});

test("a burst of three changes during one read costs two reads in all", () => {
  let state: ReadState = READ_IDLE;
  let reads = 0;
  for (const _change of [1, 2, 3]) {
    const step = onChange(state);
    state = step.state;
    if (step.read) reads += 1;
  }
  assert.equal(reads, 1);
  for (let settle = 0; settle < 2; settle++) {
    const step = onSettled(state);
    state = step.state;
    if (step.read) reads += 1;
  }
  assert.equal(reads, 2);
  assert.deepEqual(state, READ_IDLE);
});

test("a clock time reads in the named zone on the 24 hour clock", () => {
  assert.equal(clockTime("2026-10-13T14:02:10.000Z", "UTC"), "14:02:10");
  assert.equal(clockTime("2026-10-13T00:05:09.000Z", "UTC"), "00:05:09");
});

test("a healthy live book has no notice, and a polling book with no failure has none either", () => {
  const good = bookRead(BOOK_EMPTY, { ok: true }, "2026-10-13T14:02:10.000Z");
  assert.equal(freshnessNotice("live", good, "UTC"), null);
  assert.equal(freshnessNotice("polling", good, "UTC"), null);
});

test("a failed read after a good one keeps the good time and shows the stale notice", () => {
  const good = bookRead(BOOK_EMPTY, { ok: true }, "2026-10-13T14:02:10.000Z");
  const failed = bookRead(good, { ok: false, error: "Refused (SERVER_ERROR)." }, "2026-10-13T14:03:00.000Z");
  assert.deepEqual(failed, {
    lastGoodAt: "2026-10-13T14:02:10.000Z",
    failure: { at: "2026-10-13T14:03:00.000Z", error: "Refused (SERVER_ERROR)." },
  });
  assert.equal(isStale(failed), true);
  assert.deepEqual(freshnessNotice("live", failed, "UTC"), {
    tone: "warn",
    text: "Showing figures from 14:02:10. The latest refresh failed: Refused (SERVER_ERROR). Retrying every 30 seconds.",
  });
});

test("a dropped stream with a good book says the figures may be behind", () => {
  const good = bookRead(BOOK_EMPTY, { ok: true }, "2026-10-13T14:02:10.000Z");
  assert.deepEqual(freshnessNotice("reconnecting", good, "UTC"), {
    tone: "warn",
    text: "Live updates dropped. Reconnecting; figures may be behind.",
  });
});

test("a failure outranks a dropped stream", () => {
  const good = bookRead(BOOK_EMPTY, { ok: true }, "2026-10-13T14:02:10.000Z");
  const failed = bookRead(good, { ok: false, error: "Refused (SERVER_ERROR)." }, "2026-10-13T14:03:00.000Z");
  assert.deepEqual(freshnessNotice("reconnecting", failed, "UTC"), {
    tone: "warn",
    text: "Showing figures from 14:02:10. The latest refresh failed: Refused (SERVER_ERROR). Retrying every 30 seconds.",
  });
});

test("a success after a failure clears the notice and stamps the new good time", () => {
  const good = bookRead(BOOK_EMPTY, { ok: true }, "2026-10-13T14:02:10.000Z");
  const failed = bookRead(good, { ok: false, error: "Refused (SERVER_ERROR)." }, "2026-10-13T14:03:00.000Z");
  const recovered = bookRead(failed, { ok: true }, "2026-10-13T14:04:00.000Z");
  assert.deepEqual(recovered, { lastGoodAt: "2026-10-13T14:04:00.000Z", failure: null });
  assert.equal(isStale(recovered), false);
  assert.equal(freshnessNotice("live", recovered, "UTC"), null);
});

test("a failed first load has no figures to be stale, so it shows no notice", () => {
  const failed = bookRead(BOOK_EMPTY, { ok: false, error: "Refused (SERVER_ERROR)." }, "2026-10-13T14:03:00.000Z");
  assert.equal(isStale(failed), false);
  assert.equal(freshnessNotice("reconnecting", failed, "UTC"), null);
});
