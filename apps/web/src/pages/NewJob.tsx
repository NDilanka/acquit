import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { JobView, UserCommand } from "../api-types";
import { api, ApiError, type Repo, type RepoIssue } from "../api";
import { parseUsd, usd, utc } from "../format";
import { useIntent } from "../intent";
import { Link } from "../router";
import { rememberJob, useSession } from "../session";

const DEADLINES = [3, 7, 14] as const;

// Not served by the API in the skeleton; the verifier's default protected set from the tutorial.
export const PROTECTED_PATHS = "tests/**, .github/**, package.json, package-lock.json";

export function NewJob() {
  const { user } = useSession();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issueRef, setIssueRef] = useState("");
  const [budget, setBudget] = useState("400");
  const [days, setDays] = useState<number>(7);
  const [opened, setOpened] = useState<{ job: JobView; issue: RepoIssue } | null>(null);
  const intent = useIntent();

  useEffect(() => {
    api
      .repos()
      .then((r) => {
        setRepos(r.repos);
        const first = r.repos[0];
        const issue = first?.issues[0];
        if (first && issue) setIssueRef(`${first.repository}#${issue.number}`);
      })
      .catch((e: unknown) => setLoadError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  const selected = useMemo(() => {
    for (const r of repos ?? []) for (const i of r.issues) if (`${r.repository}#${i.number}` === issueRef) return { repo: r, issue: i };
    return null;
  }, [repos, issueRef]);

  const cents = parseUsd(budget);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected || cents === null || cents <= 0) {
      intent.setError("Pick an issue and enter a budget in whole dollars or cents, such as 400 or 400.00.");
      return;
    }
    const signature = JSON.stringify([issueRef, cents, days]);
    const outcome = await intent.send(signature, (): UserCommand => ({
      type: "OpenJob",
      repository: selected.repo.repository,
      issueNumber: selected.issue.number,
      budget: cents,
      deliveryEndsAt: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
    }));
    if (outcome && outcome.result.kind === "JOB") {
      rememberJob(user.handle, outcome.result.job.id);
      setOpened({ job: outcome.result.job, issue: selected.issue });
    }
  };

  if (opened) return <JobOpened job={opened.job} issue={opened.issue} />;

  return (
    <>
      <div className="crumbs">
        <Link to="/">Jobs</Link> / <b>New job</b>
      </div>
      <h1>New job</h1>
      {loadError && <div className="alert">{loadError}</div>}
      <form className="card pad form" onSubmit={(e) => void submit(e)}>
        <label>
          <span>Issue</span>
          <select value={issueRef} onChange={(e) => setIssueRef(e.target.value)} disabled={!repos}>
            {!repos && <option>Loading repositories…</option>}
            {repos?.map((r) => (
              <optgroup key={r.repository} label={r.repository}>
                {r.issues.map((i) => (
                  <option key={i.number} value={`${r.repository}#${i.number}`}>
                    #{i.number} {i.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {selected && (
            <small className="muted">
              Suite will freeze at commit <span className="mono">{selected.issue.suite.commit}</span> (
              {selected.issue.suite.visible} tests), plus {selected.issue.suite.hidden} hidden tests only the verifier sees.
            </small>
          )}
        </label>

        <fieldset>
          <legend>Mode</legend>
          <label className="radio">
            <input type="radio" name="mode" checked readOnly /> <b>Bid</b>
            <small className="muted">Operators send offers, and you pick one.</small>
          </label>
        </fieldset>

        <label>
          <span>Budget (USD)</span>
          <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          {cents !== null && <small className="muted num">{usd(cents)}</small>}
        </label>

        <label>
          <span>Deadline</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DEADLINES.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>

        {intent.error && <div className="alert">{intent.error}</div>}
        <div className="act">
          <Link to="/" className="btn ghost">Cancel</Link>
          <button className="btn" disabled={intent.busy || !selected}>
            {intent.busy ? "Opening…" : "Open job"}
          </button>
        </div>
        <p className="muted small">You do not pay yet. You pay when you accept a bid, because the payment names the operator it can go to.</p>
      </form>
    </>
  );
}

function JobOpened({ job, issue }: { job: JobView; issue: RepoIssue }) {
  return (
    <div className="card pad opened">
      <h2>
        Job <span className="mono">{job.id}</span> opened
      </h2>
      <dl className="kvs">
        <dt>Status</dt>
        <dd>{job.status}</dd>
        <dt>Mode</dt>
        <dd>Bid</dd>
        <dt>Budget</dt>
        <dd className="num">{usd(job.budget)}</dd>
        <dt>Deadline</dt>
        <dd className="num">{utc(job.deliveryEndsAt)}</dd>
        <dt>Test suite</dt>
        <dd>
          frozen at commit <span className="mono">{issue.suite.commit}</span> ({issue.suite.visible} tests)
        </dd>
        <dt>Hidden tests added</dt>
        <dd>{issue.suite.hidden}</dd>
        <dt>Protected paths</dt>
        <dd className="mono">{PROTECTED_PATHS}</dd>
      </dl>
      <div className="act">
        <Link to={`/jobs/${job.id}`} className="btn">Open job page</Link>
      </div>
    </div>
  );
}
