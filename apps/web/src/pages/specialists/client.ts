// The one place the specialist screens reach the network. Every read and write goes to the API routes.
// The only built-in data is the replays under /replays, read by loadExamReplay and loadNightReplay. They are labelled on screen.

import { ApiError } from "../../api.ts";
import {
  agentOf,
  examOf,
  examReadOf,
  examReplayOf,
  floorOf,
  nightReplayOf,
  plugOf,
  publicAgentOf,
  reportOf,
  sampleOf,
  type RawAgent,
  type RawExam,
  type RawExamRead,
  type RawExamReplay,
  type RawFloor,
  type RawMorning,
  type RawNightReplay,
  type RawPlugged,
  type RawPublicAgent,
  type RawSample,
} from "./mapping.ts";
import type { ExamReplay, NightReplay, SpecialistsApi, StandingOrders, StandingOrdersInput, Task } from "./types.ts";

type Method = "GET" | "POST" | "PUT";

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, "BAD_RESPONSE", text.slice(0, 200));
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, err.error ?? `HTTP_${res.status}`, err.detail, data);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const specialists: SpecialistsApi = {
  async samples() {
    const r = await call<{ samples: RawSample[] }>("GET", "/api/specialists/samples");
    return r.samples.map(sampleOf);
  },

  async agents() {
    const r = await call<{ agents: RawAgent[] }>("GET", "/api/me/agents");
    return r.agents.map(agentOf);
  },

  async agent(id) {
    const r = await call<{ agent: RawPublicAgent }>("GET", `/api/agents/${enc(id)}`);
    return publicAgentOf(r.agent);
  },

  async plugSample(sampleId) {
    const r = await call<{ agent: RawPlugged }>("POST", "/api/me/agents", { sample: sampleId });
    return plugOf(r.agent);
  },

  // A refused start throws with the server's code: EXAM_NOT_BUILT (503) for print, TASK_NOT_EXAMINABLE (409) for laser cut.
  async startExam(agentId) {
    const r = await call<{ exam: RawExam }>("POST", `/api/me/agents/${enc(agentId)}/exam`, {});
    return examOf(r.exam);
  },

  // The start answers the run as RUNNING. The settled counts and the acquittal show on the next read.
  async exam(agentId, examId) {
    try {
      const r = await call<RawExamRead>("GET", `/api/me/agents/${enc(agentId)}/exam?examId=${enc(examId)}`);
      return examReadOf(r);
    } catch (e) {
      // A 404 means no run with this id for this agent: the exam was never started, so there is no run to read.
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },

  async standingOrders(agentId) {
    const r = await call<{ standingOrders: StandingOrders | null }>("GET", `/api/me/agents/${enc(agentId)}/standing-orders`);
    return r.standingOrders;
  },

  async saveStandingOrders(agentId, input: StandingOrdersInput) {
    const r = await call<{ standingOrders: StandingOrders }>("PUT", `/api/me/agents/${enc(agentId)}/standing-orders`, input);
    return r.standingOrders;
  },

  async floor() {
    const r = await call<{ specialists: RawFloor[] }>("GET", "/api/floor");
    return r.specialists.map(floorOf);
  },

  async morningReport(since) {
    const r = await call<RawMorning>("GET", `/api/me/morning-report?since=${enc(since)}`);
    return reportOf(r);
  },
};

/** A replay file from /replays. Null when the file is missing or is not JSON (a dev server's fallback page is not JSON), so the screen can say so. */
async function replay<T>(name: string): Promise<T | null> {
  try {
    const res = await fetch(`/replays/${name}.json`, { credentials: "same-origin" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadExamReplay(task: Task): Promise<ExamReplay | null> {
  const raw = await replay<RawExamReplay>(`exam-${task}`);
  return raw === null ? null : examReplayOf(raw);
}

export async function loadNightReplay(task: Task): Promise<NightReplay | null> {
  const raw = await replay<RawNightReplay>(`night-${task}`);
  return raw === null ? null : nightReplayOf(raw);
}
