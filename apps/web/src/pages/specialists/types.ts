// The contract's shapes for the specialist screens (plan/contract.md section 6). The client maps every response into these.

export type Task = "code" | "print-fdm" | "laser-cut";

export type Counts = { readonly passed: number; readonly total: number };

export type StandingOrders = {
  readonly priceFloorCents: number;
  readonly maxConcurrent: number;
  readonly autopilot: boolean;
  readonly runsOn: "owner" | "acquit";
  readonly preApprove: boolean;
  readonly preApproveCap: number;
  readonly updatedAt: string;
};

export type AgentRecord = {
  readonly jobsTaken: number;
  readonly verified: number;
  readonly rejected: number;
};

/** The bid gate's answer for one agent (contract v13). OPEN lets it bid; the other two say why it cannot yet. */
export type Gate = "OPEN" | "NOT_ACQUITTED" | "WRONG_TASK";

/** One agent as the screens use it. `acquitted` is the only status word the page shows: "Acquitted" or "not acquitted". */
export type SpecialistAgent = {
  readonly id: string;
  readonly name: string;
  readonly task: Task;
  readonly runner: string;
  readonly sample: string | null;
  readonly acquitted: boolean;
  readonly grade: number | null;
  readonly seeded: boolean;
  /** Present on the agent and floor reads, absent on the owner's list. */
  readonly record?: AgentRecord;
  readonly earnedCents?: number;
  readonly standingOrders?: StandingOrders | null;
  /** Sent on the owner's list and the agent read while the exam gate setting is off. Null or absent means no gate answer. */
  readonly gate?: Gate | null;
};

export type Sample = {
  readonly id: string;
  readonly name: string;
  readonly task: Task;
  readonly runner: string;
  readonly blurb: string;
  readonly runsOn: "acquit";
  readonly plugged: string | null;
};

export type ExamStatus = "RUNNING" | "VERIFYING" | "PASSED" | "FAILED" | "ERROR";

export type Exam = {
  readonly id: string;
  readonly status: ExamStatus;
  /** Null until the run ends: the API sends no per-check progress while a run is open. */
  readonly visible: Counts | null;
  readonly hidden: Counts | null;
  readonly reasons: readonly string[];
  readonly endedAt: string | null;
  readonly startedAt: string | null;
};

/** The exam read. The API's agent part carries the acquittal only, so the page reads the grade from the agent list. */
export type ExamRead = { readonly exam: Exam; readonly acquitted: boolean };

export type Payout = { readonly reference: string; readonly amountCents: number; readonly jobId: string; readonly at: string };

export type ReportEntry = { readonly at: string; readonly jobId: string | null; readonly agentId: string | null; readonly title: string | null };

export type GradeChange = { readonly at: string; readonly agentId: string | null; readonly from: number; readonly to: number };

export type MorningReport = {
  readonly since: string;
  readonly sandbox: boolean;
  readonly bids: readonly ReportEntry[];
  readonly wins: readonly ReportEntry[];
  readonly verified: readonly ReportEntry[];
  readonly rejected: readonly ReportEntry[];
  readonly payouts: readonly Payout[];
  readonly gradeChanges: readonly GradeChange[];
  readonly preApprovals: readonly ReportEntry[];
};

/** A recorded or fixture run, read from /replays. `source` says which: "fixture" (sample data) until a real run is recorded. */
export type ReplaySource = "fixture" | "recorded";

/**
 * `visible` and `hidden` hold one flag per check: true when it passed. Check names never appear in a replay.
 * `simulated` is true for the simulated machines, whose runs never touch real hardware.
 */
export type ExamReplay = {
  readonly source: ReplaySource;
  readonly simulated: boolean;
  readonly task: Task;
  readonly visible: readonly boolean[];
  readonly hidden: readonly boolean[];
  readonly outcome: ExamStatus;
  readonly reasons: readonly string[];
};

export type NightEvent = {
  readonly at: string;
  readonly kind: "bid" | "win" | "money-held" | "delivery" | "verdict";
  readonly title: string;
  readonly detail: string;
};

export type NightReplay = {
  readonly source: ReplaySource;
  readonly simulated: boolean;
  readonly task: Task;
  readonly events: readonly NightEvent[];
};

export type FloorEntry = {
  readonly agentId: string;
  readonly name: string;
  readonly task: Task;
  readonly grade: number | null;
  readonly record: AgentRecord;
  readonly earnedCents: number;
  readonly seeded: boolean;
};

export type StandingOrdersInput = Omit<StandingOrders, "updatedAt">;

/** Every call a specialist screen makes. The live client and the fixture module both implement it. */
export type SpecialistsApi = {
  samples(): Promise<readonly Sample[]>;
  agents(): Promise<readonly SpecialistAgent[]>;
  agent(id: string): Promise<SpecialistAgent>;
  plugSample(sampleId: string): Promise<SpecialistAgent>;
  startExam(agentId: string): Promise<Exam>;
  exam(agentId: string, examId: string): Promise<ExamRead>;
  standingOrders(agentId: string): Promise<StandingOrders | null>;
  saveStandingOrders(agentId: string, input: StandingOrdersInput): Promise<StandingOrders>;
  floor(): Promise<readonly FloorEntry[]>;
  morningReport(since: string): Promise<MorningReport>;
};
