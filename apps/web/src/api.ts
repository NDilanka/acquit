import type {
  AskToolResponse,
  AskToolsResponse,
  AskTurnRequest,
  AskTurnResponse,
  CommandResponse,
  CreditAccountView,
  DemoAccessResponse,
  FigureId,
  FigureTrace,
  FundingMode,
  JobDetailResponse,
  JobResponse,
  JobView,
  OperatorEscrowRow,
  OperatorView,
  PayoutRow,
  PlatformJobLedger,
  PlatformReconciliation,
  PlatformSignedInResponse,
  PlatformTables,
  PrintRunView,
  PublicReceiptResponse,
  ReceiptRow,
  ScenarioName,
  ScenarioRun,
  ScenarioStartResponse,
  ScopingApproveResponse,
  ScopingResponse,
  SessionResponse,
  SessionUser,
  SignedInResponse,
  UserCommand,
  VerifierFields,
} from "./api-types";

export type { SessionUser };

export type RepoIssue = {
  number: number;
  title: string;
  suite: { commit: string; visible: number; hidden: number };
};
export type Repo = { repository: string; issues: RepoIssue[] };
export type AgentSummary = { id: string; name: string; runner: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  /** The whole error body, for a refusal that carries more than its code (COVERAGE_GATE names `missing`). */
  readonly body: unknown;
  constructor(status: number, code: string, detail?: string, body: unknown = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }
}

/** Per-call transport options: a cancel signal, and a fetch a test can stand in for. */
export type CallOptions = { readonly signal?: AbortSignal; readonly fetch?: typeof fetch };

async function request<T>(method: string, path: string, body?: unknown, init: CallOptions = {}): Promise<T> {
  const res = await (init.fetch ?? fetch)(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: init.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, "BAD_RESPONSE", text.slice(0, 200));
  }
  if (!res.ok) {
    // A domain refusal arrives as 409 with an outcome, not an error.
    if (res.status === 409 && isOutcome(data)) return data as T;
    const err = (data ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, err.error ?? `HTTP_${res.status}`, err.detail, data);
  }
  return data as T;
}

function isOutcome(data: unknown): boolean {
  return typeof data === "object" && data !== null && "outcome" in data;
}

export const api = {
  session: () => request<SessionResponse>("GET", "/api/session"),
  signIn: (handle: string) => request<SignedInResponse>("POST", "/api/session", { handle }),
  demoAccess: () => request<DemoAccessResponse>("GET", "/api/demo/access"),
  startDemo: () => request<SignedInResponse>("POST", "/api/demo", {}),
  switchDemo: () => request<SignedInResponse>("POST", "/api/demo/switch", {}),
  signOut: () => request<void>("DELETE", "/api/session"),
  users: () => request<{ users: SessionUser[] }>("GET", "/api/users"),
  repos: () => request<{ repos: Repo[] }>("GET", "/api/repos"),
  jobs: (status?: string) =>
    request<{ jobs: (JobView & VerifierFields)[]; nextCursor: string | null }>(
      "GET",
      status ? `/api/jobs?status=${encodeURIComponent(status)}` : "/api/jobs",
    ),
  job: (id: string) => request<JobDetailResponse>("GET", `/api/jobs/${encodeURIComponent(id)}`),
  setFunding: (id: string, mode: FundingMode) =>
    request<{ mode: FundingMode }>("POST", `/api/jobs/${encodeURIComponent(id)}/funding`, { mode }),
  scoping: (id: string) => request<ScopingResponse>("GET", `/api/jobs/${encodeURIComponent(id)}/scoping`),
  approveScoping: (id: string, leaveOut: readonly string[]) =>
    request<ScopingApproveResponse>("POST", `/api/jobs/${encodeURIComponent(id)}/scoping/approve`, { leaveOut }),
  advanceJobClock: (id: string, advanceMs: number) =>
    request<JobResponse>("POST", `/api/jobs/${encodeURIComponent(id)}/clock`, { advanceMs }),
  operator: () => request<{ operator: OperatorView; agents: AgentSummary[] }>("GET", "/api/me/operator"),
  credits: () => request<{ credits: CreditAccountView }>("GET", "/api/me/credits"),
  receipts: () => request<{ receipts: ReceiptRow[]; nextCursor: null }>("GET", "/api/me/receipts"),
  publicReceipt: (receiptId: string) =>
    request<PublicReceiptResponse>("GET", `/api/receipts/${encodeURIComponent(receiptId)}`),
  payouts: () => request<{ payouts: PayoutRow[] }>("GET", "/api/me/payouts"),
  escrow: () => request<{ escrow: OperatorEscrowRow[] }>("GET", "/api/me/escrow"),
  platformSession: (key: string) => request<PlatformSignedInResponse>("POST", "/api/platform/session", { key }),
  platformLedger: (init?: CallOptions) => request<{ jobs: PlatformJobLedger[]; now: string }>("GET", "/api/platform/ledger", undefined, init),
  platformTables: (init?: CallOptions) => request<{ tables: PlatformTables; now: string }>("GET", "/api/platform/tables", undefined, init),
  platformReconciliation: (init?: CallOptions) => request<PlatformReconciliation>("GET", "/api/platform/reconciliation", undefined, init),
  platformExplain: (figure: FigureId) => request<FigureTrace>("GET", `/api/platform/explain?figure=${encodeURIComponent(figure)}`),
  loadStudioLayout: (dashboard: string) =>
    request<{ state: string | null }>("GET", `/api/studio/layout?dashboard=${encodeURIComponent(dashboard)}`),
  saveStudioLayout: (dashboard: string, state: string) =>
    request<{ saved: true; dashboard: string }>("PUT", "/api/studio/layout", { dashboard, state }),
  command: (key: string, command: UserCommand) => request<CommandResponse>("POST", "/api/commands", { key, command }),
  approveCli: (code: string) => request<SessionUser>("POST", "/api/cli/approve", { code }),
  askLedgerTools: () => request<AskToolsResponse>("GET", "/api/ask-ledger/tools"),
  askLedgerTurn: (body: AskTurnRequest, init?: CallOptions) => request<AskTurnResponse>("POST", "/api/ask-ledger/turn", body, init),
  askLedgerTool: (name: string, args: Record<string, unknown>, init?: CallOptions) =>
    request<AskToolResponse>("POST", "/api/ask-ledger/tool", { name, arguments: args }, init),
  startScenario: (name: ScenarioName) => request<ScenarioStartResponse>("POST", `/api/demo/scenarios/${encodeURIComponent(name)}`),
  scenarioRun: (scenarioId: string) => request<ScenarioRun>("GET", `/api/demo/scenarios/${encodeURIComponent(scenarioId)}`),
  startPrintRun: (farm: string) => request<PrintRunView>("POST", "/api/demo/print/runs", { farm }),
  printRun: (runId: string) => request<PrintRunView>("GET", `/api/demo/print/runs/${encodeURIComponent(runId)}`),
};
