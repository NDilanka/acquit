import type {
  CommandOutcome,
  CreditAccountView,
  JobView,
  OperatorView,
  UserCommand,
} from "./api-types";

export type Role = "CLIENT" | "OPERATOR";
export type SessionUser = { handle: string; role: Role };

export type RepoIssue = {
  number: number;
  title: string;
  suite: { commit: string; visible: number; hidden: number };
};
export type Repo = { repository: string; issues: RepoIssue[] };
export type AgentSummary = { id: string; name: string; runner: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
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
  session: () => request<{ user: SessionUser | null }>("GET", "/api/session"),
  signIn: (handle: string) => request<{ user: SessionUser; token: string }>("POST", "/api/session", { handle }),
  signOut: () => request<void>("DELETE", "/api/session"),
  users: () => request<{ users: SessionUser[] }>("GET", "/api/users"),
  repos: () => request<{ repos: Repo[] }>("GET", "/api/repos"),
  jobs: (status?: string) =>
    request<{ jobs: JobView[]; nextCursor: string | null }>(
      "GET",
      status ? `/api/jobs?status=${encodeURIComponent(status)}` : "/api/jobs",
    ),
  job: (id: string) => request<{ job: JobView }>("GET", `/api/jobs/${encodeURIComponent(id)}`),
  operator: () => request<{ operator: OperatorView; agents: AgentSummary[] }>("GET", "/api/me/operator"),
  credits: () => request<{ credits: CreditAccountView }>("GET", "/api/me/credits"),
  command: async (key: string, command: UserCommand): Promise<CommandOutcome> =>
    (await request<{ outcome: CommandOutcome }>("POST", "/api/commands", { key, command })).outcome,
};
