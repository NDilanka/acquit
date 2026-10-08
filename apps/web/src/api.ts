import type {
  CommandResponse,
  CreditAccountView,
  FundingMode,
  JobResponse,
  JobView,
  OperatorView,
  SessionResponse,
  SessionUser,
  SignedInResponse,
  UserCommand,
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
  constructor(status: number, code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    throw new ApiError(res.status, err.error ?? `HTTP_${res.status}`, err.detail);
  }
  return data as T;
}

function isOutcome(data: unknown): boolean {
  return typeof data === "object" && data !== null && "outcome" in data;
}

export const api = {
  session: () => request<SessionResponse>("GET", "/api/session"),
  signIn: (handle: string) => request<SignedInResponse>("POST", "/api/session", { handle }),
  startDemo: () => request<SignedInResponse>("POST", "/api/demo", {}),
  switchDemo: () => request<SignedInResponse>("POST", "/api/demo/switch", {}),
  signOut: () => request<void>("DELETE", "/api/session"),
  users: () => request<{ users: SessionUser[] }>("GET", "/api/users"),
  repos: () => request<{ repos: Repo[] }>("GET", "/api/repos"),
  jobs: (status?: string) =>
    request<{ jobs: JobView[]; nextCursor: string | null }>(
      "GET",
      status ? `/api/jobs?status=${encodeURIComponent(status)}` : "/api/jobs",
    ),
  job: (id: string) => request<JobResponse>("GET", `/api/jobs/${encodeURIComponent(id)}`),
  setFunding: (id: string, mode: FundingMode) =>
    request<{ mode: FundingMode }>("POST", `/api/jobs/${encodeURIComponent(id)}/funding`, { mode }),
  advanceJobClock: (id: string, advanceMs: number) =>
    request<JobResponse>("POST", `/api/jobs/${encodeURIComponent(id)}/clock`, { advanceMs }),
  operator: () => request<{ operator: OperatorView; agents: AgentSummary[] }>("GET", "/api/me/operator"),
  credits: () => request<{ credits: CreditAccountView }>("GET", "/api/me/credits"),
  command: (key: string, command: UserCommand) => request<CommandResponse>("POST", "/api/commands", { key, command }),
  approveCli: (code: string) => request<SessionUser>("POST", "/api/cli/approve", { code }),
};
