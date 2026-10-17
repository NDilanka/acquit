import assert from "node:assert/strict";
import { test } from "node:test";
import { onChange, onSettled, parseStreamEvent, READ_IDLE, type ReadState } from "./studio/live.ts";

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
