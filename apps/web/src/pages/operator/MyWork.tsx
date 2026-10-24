import { useState } from "react";
import { usd } from "../../format";
import { Link } from "../../router";
import { buildOperatorWorkspace } from "../../operator-workspace";
import { WORK_TABS, workMatches, type WorkTab } from "../../operator-views";
import { EmptyState, Segmented } from "../../ui";
import type { OperatorData } from "./OperatorPage";

/** Contracts the operator holds, by where each one stands. The amber line marks the next step that is the operator's turn. */
export function MyWork({ data }: { data: OperatorData }) {
  const [tab, setTab] = useState<WorkTab>("active");
  const ws = buildOperatorWorkspace({
    operatorId: data.operator.id,
    handle: data.operator.handle,
    jobs: data.jobs,
    receipts: data.receipts,
    escrow: data.escrow,
  });

  const shown = ws.mine.filter(({ job }) => workMatches(job, tab));
  const options = WORK_TABS.map((t) => ({
    value: t.value,
    label: `${t.label} ${ws.mine.filter(({ job }) => workMatches(job, t.value)).length}`,
  }));

  return (
    <div className="work-page">
      <p className="work-held">
        Held for you: <b className="num">{usd(ws.earnings.heldCents)}</b>
      </p>
      <Segmented label="Work status" options={options} value={tab} onChange={setTab} round />
      {ws.mine.length === 0 ? (
        <EmptyState icon="work" action={{ to: "/operator", label: "Find work" }}>
          No awarded work yet. A bid the client accepts shows here with its next step.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="work">Nothing in this tab right now.</EmptyState>
      ) : (
        shown.map(({ job, status, next }) => {
          const held = data.escrow.find((row) => row.jobId === job.id)?.cents;
          const yourTurn = workMatches(job, "delivery");
          return (
            <article key={job.id} className="card work-row">
              <div className="work-main">
                <Link to={`/jobs/${job.id}`} className="job-title">
                  {job.title}
                </Link>
                <p className={`work-next${yourTurn ? " turn" : ""}`}>{next}</p>
                <p className="job-meta num">Money held {held === undefined ? "none" : usd(held)}</p>
              </div>
              <span className={`pill ${status.tone}`}>{status.label}</span>
              <Link to={`/jobs/${job.id}`} className="btn secondary sm">
                Open
              </Link>
            </article>
          );
        })
      )}
    </div>
  );
}
