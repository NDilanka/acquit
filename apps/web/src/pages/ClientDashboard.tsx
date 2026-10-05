import { useEffect, useState, type ReactNode } from "react";
import type { JobView } from "../api-types";
import { api, ApiError } from "../api";
import { usd, utc } from "../format";
import { Link } from "../router";
import { rememberedJobs, useSession } from "../session";
import { StatusPill } from "../ui";

/**
 * The contract documents only `GET /api/jobs?status=OPEN`. We ask for `/api/jobs` first (own jobs plus
 * OPEN), fall back to the OPEN list, and add jobs this browser opened so funded jobs stay visible.
 */
async function loadJobs(handle: string): Promise<JobView[]> {
  let listed: JobView[];
  try {
    listed = (await api.jobs()).jobs;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    listed = (await api.jobs("OPEN")).jobs;
  }
  const byId = new Map(listed.map((j) => [j.id as string, j]));
  const missing = rememberedJobs(handle).filter((id) => !byId.has(id));
  const extra = await Promise.all(missing.map((id) => api.job(id).then((r) => r.job).catch(() => null)));
  for (const j of extra) if (j) byId.set(j.id, j);
  return [...byId.values()];
}

export function ClientDashboard() {
  const { user } = useSession();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadJobs(user.handle)
      .then(setJobs)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [user.handle]);

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">Client</div>
          <h1>Your jobs</h1>
        </div>
        <Link to="/jobs/new" className="btn">New job</Link>
      </div>
      {error && <div className="alert">{error}</div>}
      {!jobs && !error && <p className="muted">Loading jobs…</p>}
      {jobs && jobs.length === 0 && (
        <div className="card pad empty">
          <p>No jobs yet. Create one from a repository issue.</p>
          <Link to="/jobs/new" className="btn">New job</Link>
        </div>
      )}
      {jobs && jobs.length > 0 && <JobTable jobs={jobs} />}
    </>
  );
}

export function JobTable({ jobs, action }: { jobs: JobView[]; action?: (job: JobView) => ReactNode }) {
  return (
    <div className="card">
      <table className="tbl">
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>Status</th>
            <th className="r">Budget</th>
            <th>Deadline</th>
            <th className="r">Bids</th>
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td className="mono">
                <Link to={`/jobs/${j.id}`}>{j.id}</Link>
              </td>
              <td>
                <Link to={`/jobs/${j.id}`}>{j.title}</Link>
              </td>
              <td>
                <StatusPill job={j} />
              </td>
              <td className="r num">{usd(j.budget)}</td>
              <td className="num">{utc(j.deliveryEndsAt)}</td>
              <td className="r num">{j.bids.operators.length + (j.bids.house ? 1 : 0)}</td>
              {action && <td className="r">{action(j)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
