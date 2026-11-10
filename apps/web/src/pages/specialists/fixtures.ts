// The fixture module: the contract's shapes (plan/contract.md section 6) held in memory. Every screen shows "Fixture data" while
// this serves. Nothing here is a real customer, job, payout or exam result.

import { ApiError } from "../../api.ts";
import type {
  AgentRecord,
  Counts,
  Exam,
  ExamRead,
  ExamStatus,
  FloorEntry,
  Gate,
  MorningReport,
  ReportEntry,
  Sample,
  SpecialistAgent,
  SpecialistsApi,
  StandingOrders,
  StandingOrdersInput,
  Task,
} from "./types.ts";

const OWNER = "you";
const DAY_MS = 24 * 60 * 60 * 1000;

type CatalogItem = Omit<Sample, "plugged">;

const CATALOG: readonly CatalogItem[] = [
  {
    id: "code-fixer",
    name: "Code fixer",
    task: "code",
    runner: "claude-code",
    blurb: "Fixes failing tests in a practice repo. Its work goes through the real verifier.",
    runsOn: "acquit",
  },
  {
    id: "print-fdm",
    name: "3D printer",
    task: "print-fdm",
    runner: "simulated-fdm",
    blurb: "Takes print jobs on a simulated printer. No real hardware.",
    runsOn: "acquit",
  },
  {
    id: "laser-cut",
    name: "Laser cutter",
    task: "laser-cut",
    runner: "simulated-laser",
    blurb: "Design only. A simulated cutter, coming later.",
    runsOn: "acquit",
  },
];

/** What each exam reads at the end. Code: the practice tests. Print: 5 fulfil challenges and 1 trap. */
const CODE_RESULT: { visible: Counts; hidden: Counts } = { visible: { passed: 5, total: 5 }, hidden: { passed: 3, total: 3 } };
const PRINT_RESULT: { visible: Counts; hidden: Counts } = { visible: { passed: 5, total: 5 }, hidden: { passed: 1, total: 1 } };

type Stored = {
  readonly id: string;
  readonly name: string;
  readonly task: Task;
  readonly runner: string;
  readonly sample: string | null;
  acquittedAt: string | null;
  grade: number | null;
  record: AgentRecord;
  earnedCents: number;
  standingOrders: StandingOrders | null;
};

type FixtureExam = { exam: Exam; agentId: string; polls: number };

const agents: Stored[] = [];
const exams: FixtureExam[] = [];
let counter = 0;

// Other owners' acquitted agents, so the floor has entries before the visitor's own pass.
const FLOOR_SEED: readonly FloorEntry[] = [
  {
    agentId: "seed-devon-ops",
    name: "devon-ops",
    task: "code",
    grade: 60,
    record: { jobsTaken: 4, verified: 4, rejected: 0 },
    earnedCents: 4000,
    seeded: true,
  },
  {
    agentId: "seed-starter-code",
    name: "starter-code",
    task: "code",
    grade: 55,
    record: { jobsTaken: 2, verified: 1, rejected: 1 },
    earnedCents: 1500,
    seeded: true,
  },
];

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 120));
const nowIso = () => new Date().toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();

function ownerAgent(id: string): Stored {
  const found = agents.find((a) => a.id === id);
  if (!found) throw new ApiError(404, "NOT_FOUND");
  return found;
}

function resultFor(task: Task): { visible: Counts; hidden: Counts } {
  if (task === "laser-cut") throw new ApiError(409, "TASK_NOT_EXAMINABLE");
  return task === "code" ? CODE_RESULT : PRINT_RESULT;
}

const isOpen = (status: ExamStatus) => status === "RUNNING" || status === "VERIFYING";

/** The same gate answer the server gives: only code work counts, and only an acquitted agent may bid. */
function gateOf(a: Stored): Gate {
  if (a.task !== "code") return "WRONG_TASK";
  return a.acquittedAt === null ? "NOT_ACQUITTED" : "OPEN";
}

function viewOf(a: Stored): SpecialistAgent {
  return {
    id: a.id,
    name: a.name,
    task: a.task,
    runner: a.runner,
    sample: a.sample,
    acquitted: a.acquittedAt !== null,
    grade: a.grade,
    seeded: false,
    standingOrders: a.standingOrders,
    gate: gateOf(a),
  };
}

/** Each read moves an open run on: running for two reads, verifying for one, then the end. */
function advance(e: FixtureExam): void {
  if (!isOpen(e.exam.status)) return;
  e.polls += 1;
  if (e.polls <= 2) return;
  if (e.polls === 3) {
    e.exam = { ...e.exam, status: "VERIFYING" };
    return;
  }
  const a = ownerAgent(e.agentId);
  const result = resultFor(a.task);
  const endedAt = nowIso();
  e.exam = { ...e.exam, status: "PASSED", visible: result.visible, hidden: result.hidden, endedAt };
  if (a.acquittedAt === null) {
    a.acquittedAt = endedAt;
    a.grade = 50;
  }
}

const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 3;

function reportSince(since: string): MorningReport {
  const entry = (hours: number, jobId: string, title: string): ReportEntry => ({ at: hoursAgo(hours), jobId, agentId: null, title });
  const keep = (list: readonly ReportEntry[]) => list.filter((e) => e.at >= since);
  const bids = [entry(10, "job_fixture_1", "Fix the flaky date test"), entry(9.5, "job_fixture_2", "Rename the config key"), entry(6, "job_fixture_3", "Add a missing null check")];
  const wins = [entry(9, "job_fixture_1", "Fix the flaky date test"), entry(5.5, "job_fixture_2", "Rename the config key")];
  const verified = [entry(7, "job_fixture_1", "Fix the flaky date test")];
  const rejected = [entry(4, "job_fixture_2", "Rename the config key")];
  return {
    since,
    sandbox: true,
    bids: keep(bids),
    wins: keep(wins),
    verified: keep(verified),
    rejected: keep(rejected),
    payouts: [{ reference: "SANDBOX-PAYOUT-0001", amountCents: 1000, jobId: "job_fixture_1", at: hoursAgo(6.5) }].filter((p) => p.at >= since),
    gradeChanges: [
      { at: hoursAgo(7), agentId: null, from: 50, to: 55 },
      { at: hoursAgo(4), agentId: null, from: 55, to: 45 },
    ].filter((g) => g.at >= since),
    preApprovals: [],
  };
}

export const fixtureApi: SpecialistsApi = {
  async samples(): Promise<readonly Sample[]> {
    await pause();
    return CATALOG.map((c) => ({ ...c, plugged: agents.find((a) => a.sample === c.id)?.id ?? null }));
  },

  async agents() {
    await pause();
    return agents.map(viewOf);
  },

  async agent(id) {
    await pause();
    const a = ownerAgent(id);
    return { ...viewOf(a), record: { ...a.record }, earnedCents: a.earnedCents };
  },

  async plugSample(sampleId) {
    await pause();
    const item = CATALOG.find((c) => c.id === sampleId);
    if (!item) throw new ApiError(400, "BAD_REQUEST", "Unknown sample.");
    if (item.task === "laser-cut") throw new ApiError(409, "TASK_NOT_EXAMINABLE");
    if (agents.some((a) => a.sample === sampleId)) throw new ApiError(409, "AGENT_EXISTS");
    counter += 1;
    const a: Stored = {
      id: `agent_${counter}`,
      name: `${sampleId}-${OWNER}`,
      task: item.task,
      runner: item.runner,
      sample: sampleId,
      acquittedAt: null,
      grade: null,
      record: { jobsTaken: 0, verified: 0, rejected: 0 },
      earnedCents: 0,
      standingOrders: null,
    };
    agents.push(a);
    return viewOf(a);
  },

  async startExam(agentId): Promise<Exam> {
    await pause();
    const a = ownerAgent(agentId);
    if (a.task === "laser-cut") throw new ApiError(409, "TASK_NOT_EXAMINABLE");
    if (a.acquittedAt !== null) throw new ApiError(409, "ALREADY_ACQUITTED");
    const mine = exams.filter((e) => e.agentId === agentId);
    if (mine.some((e) => isOpen(e.exam.status))) throw new ApiError(409, "EXAM_RUNNING");
    const recent = mine.filter((e) => Date.parse(e.exam.startedAt ?? "") > Date.now() - DAY_MS);
    if (recent.length >= 3) throw new ApiError(409, "EXAM_LIMIT");
    counter += 1;
    const exam: Exam = {
      id: `exam_${counter}`,
      status: "RUNNING",
      visible: null,
      hidden: null,
      reasons: [],
      endedAt: null,
      startedAt: nowIso(),
    };
    exams.push({ exam, agentId, polls: 0 });
    return exam;
  },

  async exam(agentId, examId): Promise<ExamRead> {
    await pause();
    const e = exams.find((x) => x.exam.id === examId && x.agentId === agentId);
    if (!e) throw new ApiError(404, "NOT_FOUND");
    advance(e);
    return { exam: e.exam, acquitted: ownerAgent(agentId).acquittedAt !== null };
  },

  async standingOrders(agentId) {
    await pause();
    return ownerAgent(agentId).standingOrders;
  },

  async saveStandingOrders(agentId, input: StandingOrdersInput) {
    await pause();
    const a = ownerAgent(agentId);
    if (a.acquittedAt === null) throw new ApiError(409, "NOT_ACQUITTED");
    if (input.runsOn === "acquit" && a.sample === null) throw new ApiError(409, "RUNS_ON_NOT_ALLOWED");
    if (!Number.isInteger(input.priceFloorCents) || input.priceFloorCents <= 0) {
      throw new ApiError(400, "BAD_REQUEST", "The price must be a whole number of cents, above zero.");
    }
    if (!inRange(input.maxConcurrent) || !inRange(input.preApproveCap)) {
      throw new ApiError(400, "BAD_REQUEST", "Jobs at a time and the daily cap must be 1 to 3.");
    }
    const saved: StandingOrders = { ...input, updatedAt: nowIso() };
    a.standingOrders = saved;
    return saved;
  },

  async floor(): Promise<readonly FloorEntry[]> {
    await pause();
    const mine: FloorEntry[] = agents
      .filter((a) => a.acquittedAt !== null)
      .map((a) => ({ agentId: a.id, name: a.name, task: a.task, grade: a.grade, record: { ...a.record }, earnedCents: a.earnedCents, seeded: false }));
    return [...FLOOR_SEED, ...mine].sort((x, y) => (y.grade ?? -1) - (x.grade ?? -1));
  },

  async morningReport(since) {
    await pause();
    return reportSince(since);
  },
};
