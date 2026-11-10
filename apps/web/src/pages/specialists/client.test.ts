import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { ApiError } from "../../api.ts";
import { specialists } from "./client.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answer(status: number, body: unknown) {
  const calls: { path: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (path, init) => {
    calls.push({ path: String(path), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test("owner activity reads the contract unchanged, with optional bounded limit and same-origin credentials", async () => {
  const example = JSON.parse(readFileSync(new URL("./__fixtures__/activity.example.json",import.meta.url),"utf8"));
  const calls = answer(200,example);
  assert.deepEqual(await specialists.activity(),example);
  assert.equal(calls[0]?.path,"/api/me/activity");
  assert.equal(calls[0]?.init?.method,"GET");
  assert.equal(calls[0]?.init?.credentials,"same-origin");
  assert.equal(calls[0]?.init?.body,undefined);
  await specialists.activity(50);
  assert.equal(calls[1]?.path,"/api/me/activity?limit=50");
  for (const limit of [0,51,1.5,NaN]) await assert.rejects(specialists.activity(limit),RangeError);
  assert.equal(calls.length,2);
});

test("only an activity 404 silently selects the legacy read path", async () => {
  for (const status of [401,403,500,503]) {
    answer(status,{error:status === 403 ? "NOT_OWNER" : "UNAVAILABLE"});
    await assert.rejects(specialists.activity(),error => error instanceof ApiError && error.status === status);
  }
  globalThis.fetch = async () => { throw new TypeError("Network unavailable"); };
  await assert.rejects(specialists.activity(),TypeError);
  const calls=answer(404,{error:"NOT_FOUND"});
  assert.equal(await specialists.activity(),null);
  assert.equal(await specialists.activity(50),null);
  assert.equal(calls.length,1);
  await assert.rejects(specialists.activity(0),RangeError);
});

test("the on-load exam read requests the newest server record without an exam query", async () => {
  const calls = answer(200, {
    exam: { id: "stored-run", status: "PASSED", simulated: true,
      visible: { passed: 5, total: 5 }, hidden: { passed: 3, total: 3 }, endedAt: "2026-11-10T12:00:00Z" },
    agent: { acquittal: { examId: "stored-run", at: "2026-11-10T12:00:00Z", simulated: true } },
  });
  const record = await specialists.exam("agent / code");
  assert.equal(calls[0]?.path, "/api/me/agents/agent%20%2F%20code/exam");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(record?.exam.id, "stored-run");
  assert.equal(record?.exam.simulated, true);
  assert.deepEqual(record?.exam.hidden, { passed: 3, total: 3 });
  assert.equal(record?.exam.endedAt, "2026-11-10T12:00:00Z");
  assert.equal(record?.acquitted, true);
});

test("a record link and polling read request the named run", async () => {
  const calls = answer(200, { exam: { id: "run / 1", status: "RUNNING" }, agent: { acquittal: null } });
  const record = await specialists.exam("agent", "run / 1");
  assert.equal(calls[0]?.path, "/api/me/agents/agent/exam?examId=run%20%2F%201");
  assert.equal(record?.exam.visible, null);
  assert.equal(record?.exam.simulated, false);
});

test("404 is a null not-started read for newest and named exams", async () => {
  answer(404, { error: "NOT_FOUND" });
  assert.equal(await specialists.exam("agent"), null);
  assert.equal(await specialists.exam("agent", "gone"), null);
});

test("a failed read never becomes a null not-started result", async () => {
  answer(503, { error: "UNAVAILABLE" });
  await assert.rejects(specialists.exam("agent"), (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === "UNAVAILABLE");
});

test("live start remains a POST and preserves the server's unsupported-task codes", async () => {
  for (const [status, error] of [[503, "EXAM_NOT_BUILT"], [409, "TASK_NOT_EXAMINABLE"]] as const) {
    const calls = answer(status, { error });
    await assert.rejects(specialists.startExam("agent"), (e: unknown) => e instanceof ApiError && e.code === error && e.status === status);
    assert.equal(calls[0]?.path, "/api/me/agents/agent/exam");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[0]?.init?.body, "{}");
  }
});
