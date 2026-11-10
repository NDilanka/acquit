// The API contract's raw response shapes and the mappers that turn them into the screens' types.
// Kept apart from client.ts so the mapping can be tested without the network or Vite's env.

import type {
  AgentRecord,
  Exam,
  ExamRead,
  ExamReplay,
  ExamStatus,
  FloorEntry,
  Gate,
  MorningReport,
  NightEvent,
  NightReplay,
  ReplaySource,
  ReportEntry,
  Sample,
  SpecialistAgent,
  StandingOrders,
  Task,
} from "./types.ts";
import { flagsFrom } from "./view.ts";

export type RawAcquittal = { examId: string; at: string; seeded?: boolean } | null;

export type RawSample = Omit<Sample, "runsOn">;

export type RawAgent = {
  id: string;
  name: string;
  task: Task;
  runner: string;
  sample: string | null;
  acquittal: RawAcquittal;
  grade: number | null;
  standingOrders?: StandingOrders | null;
  gate?: Gate | null;
};

export type RawPlugged = { id: string; name: string; task: Task; runner: string; sample: string | null };

export type RawPublicAgent = {
  id: string;
  name: string;
  task: Task;
  runner: string;
  acquittal: RawAcquittal;
  grade: number | null;
  gate?: Gate | null;
  record: AgentRecord & { earnedCents?: number };
};

export type RawExam = {
  id: string;
  status: ExamStatus;
  visible?: { passed: number; total: number } | null;
  hidden?: { passed: number; total: number } | null;
  reasons?: string[];
  endedAt?: string | null;
  startedAt?: string | null;
  simulated?: boolean;
};

export type RawFloor = {
  agentId: string;
  name: string;
  task: Task;
  grade: number | null;
  record: AgentRecord;
  earnedCents: number;
  seeded?: boolean;
};

/** A morning entry. The API also sends amountCents, bidId and runId, which the screens do not read. */
export type RawEntry = { at: string; jobId?: string | null; agentId?: string | null; title?: string | null };

export type RawMorning = {
  since: string;
  sandbox: boolean;
  bids: RawEntry[];
  wins: RawEntry[];
  verified: RawEntry[];
  rejected: RawEntry[];
  payouts: { reference: string; amountCents: number; jobId: string; at: string }[];
  gradeChanges: { at: string; agentId: string | null; delta: number }[];
  preApprovals?: RawEntry[];
};

export function sampleOf(raw: RawSample): Sample {
  return { id: raw.id, name: raw.name, task: raw.task, runner: raw.runner, blurb: raw.blurb, runsOn: "acquit", plugged: raw.plugged };
}

/** An agent on the owner's own list. `seeded` comes only from the acquittal the API marks as seeded. */
export function agentOf(raw: RawAgent): SpecialistAgent {
  return {
    id: raw.id,
    name: raw.name,
    task: raw.task,
    runner: raw.runner,
    sample: raw.sample,
    acquitted: raw.acquittal !== null,
    grade: raw.grade,
    seeded: raw.acquittal?.seeded === true,
    standingOrders: raw.standingOrders ?? null,
    gate: raw.gate ?? null,
  };
}

/** The agent the plug-in call returns: never acquitted yet. */
export function plugOf(raw: RawPlugged): SpecialistAgent {
  return {
    id: raw.id,
    name: raw.name,
    task: raw.task,
    runner: raw.runner,
    sample: raw.sample,
    acquitted: false,
    grade: null,
    seeded: false,
    standingOrders: null,
  };
}

/** The public agent read. `seeded` comes only from the acquittal the API marks as seeded, the same as on the owner's list. */
export function publicAgentOf(raw: RawPublicAgent): SpecialistAgent {
  return {
    id: raw.id,
    name: raw.name,
    task: raw.task,
    runner: raw.runner,
    sample: null,
    acquitted: raw.acquittal !== null,
    grade: raw.grade,
    seeded: raw.acquittal?.seeded === true,
    gate: raw.gate ?? null,
    record: recordOf(raw.record),
    earnedCents: raw.record.earnedCents ?? 0,
  };
}

export function recordOf(raw: AgentRecord): AgentRecord {
  return { jobsTaken: raw.jobsTaken, verified: raw.verified, rejected: raw.rejected };
}

export function examOf(raw: RawExam): Exam {
  return {
    id: raw.id,
    status: raw.status,
    visible: raw.visible ?? null,
    hidden: raw.hidden ?? null,
    reasons: raw.reasons ?? [],
    endedAt: raw.endedAt ?? null,
    startedAt: raw.startedAt ?? null,
    ...(raw.simulated !== undefined ? { simulated: raw.simulated } : {}),
  };
}

export type RawExamRead = { exam: RawExam; agent: { acquittal: RawAcquittal } };

/** The exam read. Acquitted comes from the agent's acquittal, which the page uses to show the grade. */
export function examReadOf(raw: RawExamRead): ExamRead {
  return { exam: examOf(raw.exam), acquitted: raw.agent.acquittal !== null };
}

/** A replay file under /replays. `recordedAt` null means the file is sample data, not a recorded run. */
export type RawReplayEnvelope = { recordedAt: string | null; simulated: boolean; task: Task };
export type RawExamReplay = RawReplayEnvelope & { exam: RawExam };
export type RawNightReplay = RawReplayEnvelope & { night: { events: NightEvent[] } };

function replaySource(raw: RawReplayEnvelope): ReplaySource {
  return raw.recordedAt === null ? "fixture" : "recorded";
}

export function examReplayOf(raw: RawExamReplay): ExamReplay {
  const exam = examOf(raw.exam);
  return {
    source: replaySource(raw),
    simulated: raw.simulated,
    task: raw.task,
    visible: exam.visible ? flagsFrom(exam.visible) : [],
    hidden: exam.hidden ? flagsFrom(exam.hidden) : [],
    outcome: exam.status,
    reasons: exam.reasons,
    recordedAt: raw.recordedAt,
    endedAt: exam.endedAt,
  };
}

export function nightReplayOf(raw: RawNightReplay): NightReplay {
  return { source: replaySource(raw), simulated: raw.simulated, task: raw.task, events: raw.night.events };
}

export function entryOf(raw: RawEntry): ReportEntry {
  return { at: raw.at, jobId: raw.jobId ?? null, agentId: raw.agentId ?? null, title: raw.title ?? null };
}

export function floorOf(raw: RawFloor): FloorEntry {
  return {
    agentId: raw.agentId,
    name: raw.name,
    task: raw.task,
    grade: raw.grade,
    record: recordOf(raw.record),
    earnedCents: raw.earnedCents,
    seeded: raw.seeded === true,
  };
}

/** The morning report. Payouts keep only the four fields the page reads: reference, amountCents, jobId and at. */
export function reportOf(raw: RawMorning): MorningReport {
  return {
    since: raw.since,
    sandbox: raw.sandbox,
    bids: raw.bids.map(entryOf),
    wins: raw.wins.map(entryOf),
    verified: raw.verified.map(entryOf),
    rejected: raw.rejected.map(entryOf),
    payouts: raw.payouts.map((p) => ({ reference: p.reference, amountCents: p.amountCents, jobId: p.jobId, at: p.at })),
    gradeChanges: raw.gradeChanges.map((g) => ({ at: g.at, agentId: g.agentId ?? null, delta: g.delta })),
    preApprovals: (raw.preApprovals ?? []).map(entryOf),
  };
}
