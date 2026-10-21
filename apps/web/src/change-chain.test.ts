import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgAiTelemetryObserver } from "ag-studio";
import {
  appendLink,
  canonicalJson,
  changeLogFor,
  createAttributor,
  HAND_EDIT,
  linkHash,
  listedLinks,
  verifyChain,
  type ChainLink,
  type ChangeSource,
  type EntryFields,
  type UndoEntry,
} from "./change-chain.ts";

type ChangeEvent = Parameters<AgAiTelemetryObserver["onEvent"]>[0];

const trace = (runId: string, agentId: string, parentToolCallId?: string) => ({
  threadId: "thread",
  runId,
  agentId,
  ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});

const started = (runId: string, agentId: string, toolCallId: string, name: string, args: unknown = {}, parentToolCallId?: string) =>
  ({
    type: "tool_execution_started",
    timestamp: 0,
    trace: trace(runId, agentId, parentToolCallId),
    toolCallId,
    name,
    kind: "server",
    args,
    schemaBytes: 0,
  }) as unknown as ChangeEvent;

const finished = (runId: string, agentId: string, toolCallId: string, name: string, parentToolCallId?: string) =>
  ({
    type: "tool_execution_finished",
    timestamp: 0,
    trace: trace(runId, agentId, parentToolCallId),
    toolCallId,
    name,
    kind: "server",
    ok: true,
  }) as unknown as ChangeEvent;

const runFinished = (runId: string, agentId: string) =>
  ({ type: "run_finished", timestamp: 0, trace: trace(runId, agentId), status: "error" }) as unknown as ChangeEvent;

const change = (n: number): EntryFields => ({
  kind: "change",
  entryId: `e${n}`,
  label: `Change ${n}`,
  at: 1000 + n,
  agent: "Ask the ledger",
  tool: "add_widget",
  toolCallId: `c${n}`,
  parentToolCallId: null,
});

async function chainOf(count: number): Promise<ChainLink[]> {
  let links: ChainLink[] = [];
  for (let n = 1; n <= count; n++) links = await appendLink(links, change(n));
  return links;
}

test("canonical JSON sorts keys at every depth and leaves out undefined", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [{ z: 1, y: null }], c: "x" }, u: undefined }),
    '{"a":{"c":"x","d":[{"y":null,"z":1}]},"b":1}',
  );
});

test("a link hashes to the SHA-256 of its canonical JSON, the same on every run", async () => {
  const [first] = await appendLink([], change(1));
  const [again] = await appendLink([], change(1));
  assert.ok(first, "the link is appended");
  assert.equal(first.hash, again?.hash);
  const { hash, ...body } = first;
  assert.equal(hash, createHash("sha256").update(canonicalJson(body)).digest("hex"));
  assert.equal(hash, await linkHash(body));
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("an untouched chain verifies, and each link names the hash of the link before it", async () => {
  const links = await chainOf(4);
  assert.equal(links[0]?.prevHash, null, "the first link has no predecessor");
  for (let i = 1; i < links.length; i++) assert.equal(links[i]?.prevHash, links[i - 1]?.hash, `link ${i + 1} names link ${i}`);
  assert.deepEqual(await verifyChain(links), { ok: true });
});

test("an altered label fails the chain at that link, wherever it sits", async () => {
  const links = await chainOf(4);
  for (let index = 0; index < links.length; index++) {
    const tampered = links.map((link, i) => (i === index ? { ...link, label: "Something else" } : link));
    assert.deepEqual(await verifyChain(tampered), { ok: false, seq: index + 1 }, `a label altered at #${index + 1}`);
  }
});

test("an altered prevHash fails the chain at that link", async () => {
  const links = await chainOf(4);
  const tampered = links.map((link, i) => (i === 3 ? { ...link, prevHash: "0".repeat(64) } : link));
  assert.deepEqual(await verifyChain(tampered), { ok: false, seq: 4 });
});

test("a reordered or dropped link fails the chain at the first place it is out of line", async () => {
  const links = await chainOf(4);
  const swapped = [links[0], links[2], links[1], links[3]].filter((link): link is ChainLink => link !== undefined);
  assert.deepEqual(await verifyChain(swapped), { ok: false, seq: 2 }, "two links swapped");
  const dropped = links.filter((_, i) => i !== 1);
  assert.deepEqual(await verifyChain(dropped), { ok: false, seq: 2 }, "one link dropped");
});

test("an undo link is appended, and the links before it keep their hashes", async () => {
  const before = await chainOf(3);
  const after = await appendLink(before, { ...change(9), kind: "undo", entryId: "e1", label: "Undo to Change 1", agent: HAND_EDIT.agent, tool: null, toolCallId: null });
  assert.deepEqual(after.slice(0, 3), before, "the earlier links are untouched");
  assert.equal(after[3]?.kind, "undo");
  assert.equal(after[3]?.entryId, "e1", "the undo names the entry it went back to");
  assert.equal(after[3]?.seq, 4);
  assert.deepEqual(await verifyChain(after), { ok: true });
});

test("an entry is attributed to the call that made it, a delegated child's entry to its agent, and an edit with no call to You", () => {
  const history: UndoEntry[] = [];
  const recorded: { id: string; source: ChangeSource }[] = [];
  const attributor = createAttributor({
    askAgent: "Ask the ledger",
    readUndo: () => history,
    record: (entry, source) => {
      recorded.push({ id: entry.id, source });
    },
    baseline: () => undefined,
  });
  // The user's first action, then a hand edit, then the assistant adds a widget with a call of its own.
  attributor.begin();
  history.push({ id: "h1", label: "Move widget", at: 1 });
  attributor.onEvent(started("r1", "ask-ledger", "c1", "add_widget"));
  history.push({ id: "e1", label: "Add widget", at: 2 });
  attributor.onEvent(finished("r1", "ask-ledger", "c1", "add_widget"));
  // The assistant delegates to the widget agent, whose add_widget call makes an entry.
  attributor.onEvent(started("r1", "ask-ledger", "d1", "delegate_to", { type: { id: "widget", widgetId: "w1" } }));
  attributor.onEvent(started("r2", "widget-child", "c2", "add_widget", {}, "d1"));
  history.push({ id: "e2", label: "Add widget w1", at: 3 });
  attributor.onEvent(finished("r2", "widget-child", "c2", "add_widget", "d1"));
  attributor.onEvent(runFinished("r2", "widget-child"));
  attributor.onEvent(finished("r1", "ask-ledger", "d1", "delegate_to"));
  // A hand edit after the call ends is picked up on the next look.
  history.push({ id: "e3", label: "Resize widget", at: 4 });
  attributor.sync();

  assert.deepEqual(recorded, [
    { id: "h1", source: HAND_EDIT },
    { id: "e1", source: { agent: "Ask the ledger", tool: "add_widget", toolCallId: "c1", parentToolCallId: null } },
    { id: "e2", source: { agent: "Widget agent", tool: "add_widget", toolCallId: "c2", parentToolCallId: "d1" } },
    { id: "e3", source: HAND_EDIT },
  ]);
});

test("an edit made while a call is open waits for the call, and a call that never reports its end does not hold back later edits", () => {
  const history: UndoEntry[] = [];
  const recorded: string[] = [];
  const attributor = createAttributor({
    askAgent: "Ask the ledger",
    readUndo: () => history,
    record: (entry, source) => {
      recorded.push(`${entry.id}:${source.agent}`);
    },
    baseline: () => undefined,
  });
  attributor.onEvent(started("r9", "ask-ledger", "c9", "update_widget"));
  history.push({ id: "h8", label: "Edit during call", at: 8 });
  attributor.sync();
  assert.deepEqual(recorded, [], "an edit while a call is open waits for the call");
  attributor.onEvent(runFinished("r9", "ask-ledger"));
  assert.deepEqual(recorded, ["h8:Ask the ledger"], "the run that ended with the call open gives its edit to that call");
  history.push({ id: "h9", label: "Hand edit", at: 9 });
  attributor.sync();
  assert.deepEqual(recorded.at(-1), "h9:You", "a later hand edit is not held back");
});

test("the change log records changes in order, undo appends an undo link, and an entry that is gone cannot be undone again", async () => {
  const entries: UndoEntry[] = [];
  const undone: string[] = [];
  const api = {
    getHistory: () => ({ type: "AgReportHistory", current: {}, undo: entries.map((entry) => ({ ...entry, state: {} })), redo: [] }),
    undo: (toEntryId?: string) => {
      undone.push(toEntryId ?? "");
      const at = entries.findIndex((entry) => entry.id === toEntryId);
      if (at >= 0) entries.splice(at);
    },
  } as unknown as Parameters<typeof changeLogFor>[0];
  const log = changeLogFor(api, "Ask the ledger");
  assert.equal(changeLogFor(api, "Ask the ledger"), log, "one log per Studio instance");

  // The assistant adds a widget, then the user moves it by hand.
  log.observer.onEvent(started("r1", "ask-ledger", "c1", "add_widget"));
  entries.push({ id: "e1", label: "Add widget", at: 1 });
  log.observer.onEvent(finished("r1", "ask-ledger", "c1", "add_widget"));
  entries.push({ id: "e2", label: "Move widget", at: 2 });
  log.sync();
  await log.settled();

  // The chain opens with the baseline: the empty history the first call started from.
  const links = log.getSnapshot().links;
  assert.equal(links[0]?.kind, "baseline", "the chain opens with the baseline");
  assert.deepEqual(
    listedLinks(links).map((link) => [link.label, link.agent, link.tool]),
    [
      ["Add widget", "Ask the ledger", "add_widget"],
      ["Move widget", "You", null],
    ],
  );
  assert.deepEqual(log.getSnapshot().check, { ok: true });
  assert.deepEqual([...log.getSnapshot().undoIds], ["e1", "e2"]);

  log.undo("e2");
  await log.settled();
  const after = log.getSnapshot().links;
  assert.deepEqual(undone, ["e2"]);
  assert.equal(after.length, links.length + 1, "the undo appends one link");
  assert.deepEqual(after.slice(0, links.length), links, "the links before the undo keep their hashes");
  assert.equal(after.at(-1)?.kind, "undo");
  assert.equal(after.at(-1)?.entryId, "e2");
  assert.equal(after.at(-1)?.label, "Undo to Move widget");
  assert.deepEqual(log.getSnapshot().check, { ok: true });
  assert.deepEqual([...log.getSnapshot().undoIds], ["e1"], "the undone entry leaves the undo stack");

  log.undo("e2");
  await log.settled();
  assert.equal(log.getSnapshot().links.length, links.length + 1, "undoing an entry that is no longer undoable adds nothing");
  assert.deepEqual(undone, ["e2"]);
});

/** A change log over a Studio history the test writes by hand, and the undo that goes back through an entry. */
function logOver(initial: UndoEntry[]) {
  const entries = [...initial];
  const undone: string[] = [];
  const api = {
    getHistory: () => ({ type: "AgReportHistory", current: {}, undo: entries.map((entry) => ({ ...entry, state: {} })), redo: [] }),
    undo: (toEntryId?: string) => {
      undone.push(toEntryId ?? "");
      const at = entries.findIndex((entry) => entry.id === toEntryId);
      if (at >= 0) entries.splice(at);
    },
  } as unknown as Parameters<typeof changeLogFor>[0];
  return { entries, undone, log: changeLogFor(api, "Ask the ledger") };
}

test("entries Studio made before any action are the baseline: no rows, and no link until the first action", async () => {
  // Studio's own load and seed writes land before anyone acts, so the list stays empty.
  const { entries, log } = logOver([
    { id: "L1", label: "Seed widgets", at: 1 },
    { id: "L2", label: "Restore layout", at: 2 },
  ]);
  log.sync();
  await log.settled();
  assert.deepEqual(log.getSnapshot().links, [], "no link before the first real action");
  assert.deepEqual(listedLinks(log.getSnapshot().links), [], "no rows before the first real action");
  assert.deepEqual([...log.getSnapshot().undoIds], ["L1", "L2"], "the entries are still on the undo stack");

  // The first agent call takes the baseline: both entries, the newest of them L2.
  log.observer.onEvent(started("r1", "ask-ledger", "c1", "add_widget"));
  entries.push({ id: "e1", label: "Add widget", at: 3 });
  log.observer.onEvent(finished("r1", "ask-ledger", "c1", "add_widget"));
  await log.settled();
  const links = log.getSnapshot().links;
  const baseline = links[0];
  if (baseline?.kind !== "baseline") assert.fail("the chain opens with the baseline");
  assert.equal(baseline.count, 2, "the baseline holds the two entries");
  assert.equal(baseline.entryId, "L2", "the baseline's newest entry");
  assert.deepEqual(listedLinks(links).map((link) => link.entryId), ["e1"], "only the call's entry is listed");
  assert.deepEqual(log.getSnapshot().check, { ok: true });
});

test("a hand edit after the first user interaction in the Studio host is listed as You", async () => {
  const { entries, log } = logOver([{ id: "L1", label: "Seed widgets", at: 1 }]);
  log.sync();
  // The user's first interaction ends the baseline, so the seed entry L1 is not listed.
  log.interact();
  entries.push({ id: "H1", label: "Move widget", at: 5 });
  log.sync();
  await log.settled();
  assert.deepEqual(
    listedLinks(log.getSnapshot().links).map((link) => [link.entryId, link.agent, link.tool]),
    [["H1", "You", null]],
  );
  assert.deepEqual(log.getSnapshot().check, { ok: true });
});

test("an entry an agent call makes is listed with that call's agent, tool and call id", async () => {
  const { entries, log } = logOver([{ id: "L1", label: "Seed widgets", at: 1 }]);
  log.observer.onEvent(started("r1", "ask-ledger", "c1", "add_widget"));
  entries.push({ id: "e1", label: "Add widget", at: 2 });
  log.observer.onEvent(finished("r1", "ask-ledger", "c1", "add_widget"));
  await log.settled();
  const listed = listedLinks(log.getSnapshot().links);
  assert.equal(listed.length, 1, "the seed entry L1 is not listed");
  assert.deepEqual(
    listed.map((link) => ({ entryId: link.entryId, label: link.label, kind: link.kind, agent: link.agent, tool: link.tool, toolCallId: link.toolCallId })),
    [{ entryId: "e1", label: "Add widget", kind: "change", agent: "Ask the ledger", tool: "add_widget", toolCallId: "c1" }],
  );
});

test("an undo never targets a baseline entry, and a listed change can still be undone", async () => {
  const { entries, undone, log } = logOver([
    { id: "L1", label: "Seed widgets", at: 1 },
    { id: "L2", label: "Restore layout", at: 2 },
  ]);
  log.observer.onEvent(started("r1", "ask-ledger", "c1", "add_widget"));
  entries.push({ id: "e1", label: "Add widget", at: 3 });
  log.observer.onEvent(finished("r1", "ask-ledger", "c1", "add_widget"));
  await log.settled();
  const before = log.getSnapshot().links;

  // L2 is the newest baseline entry and is still on the undo stack, but Undo refuses it.
  log.undo("L2");
  await log.settled();
  assert.deepEqual(undone, [], "Studio is never asked to undo a baseline entry");
  assert.deepEqual(log.getSnapshot().links, before, "no undo link is appended");
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["L1", "L2", "e1"],
    "the baseline entries stay",
  );

  log.undo("e1");
  await log.settled();
  assert.deepEqual(undone, ["e1"], "a listed change is undone");
  assert.equal(log.getSnapshot().links.at(-1)?.kind, "undo");
});

test("the baseline is the first link of the chain, and verify fails at it if it is altered", async () => {
  const { entries, log } = logOver([
    { id: "L1", label: "Seed widgets", at: 1 },
    { id: "L2", label: "Restore layout", at: 2 },
  ]);
  log.observer.onEvent(started("r1", "ask-ledger", "c1", "add_widget"));
  entries.push({ id: "e1", label: "Add widget", at: 3 });
  log.observer.onEvent(finished("r1", "ask-ledger", "c1", "add_widget"));
  await log.settled();
  const links = log.getSnapshot().links;
  assert.equal(links.length, 2, "the baseline, then the change");
  assert.deepEqual(await verifyChain(links), { ok: true });

  const baseline = links[0];
  if (baseline?.kind !== "baseline") assert.fail("the chain opens with the baseline");
  const others = links.slice(1);
  assert.deepEqual(await verifyChain([{ ...baseline, count: 3 }, ...others]), { ok: false, seq: 1 }, "a baseline count altered");
  assert.deepEqual(await verifyChain([{ ...baseline, entryId: "L1" }, ...others]), { ok: false, seq: 1 }, "a baseline entry altered");
  assert.deepEqual(await verifyChain(others), { ok: false, seq: 1 }, "the baseline dropped");
});
