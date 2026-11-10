import { shortId, usd, utc } from "../../format.ts";
import { EmptyState, SkeletonCard, StatTile } from "../../ui.tsx";
import { specialists } from "./client.ts";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { MorningReport, ReportEntry, SpecialistAgent } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import { entryTitle, gradeChangeWords, paidTotalCents, sinceIso } from "./view.ts";

export function MorningPage() {
  return (
    <SpecialistPage
      step={5}
      lead="What your agents did in the last 24 hours. Payouts run on the PayPal sandbox, so the references are test references, not money."
    >
      <MorningBody />
    </SpecialistPage>
  );
}

function MorningBody() {
  const report = useLoad(() => specialists.morningReport(sinceIso(Date.now())), "morning");
  // Names come from the agent list. If that list cannot be read, entries fall back to "An agent".
  const agents = useLoad(() => specialists.agents(), "agents");
  if (report.data === null) {
    return report.error !== null ? (
      <LoadFailed error={report.error} onRetry={report.reload} />
    ) : (
      <SkeletonCard lines={6} />
    );
  }
  return <Report report={report.data} agents={agents.data ?? []} />;
}

function Report({ report, agents }: { readonly report: MorningReport; readonly agents: readonly SpecialistAgent[] }) {
  const nameOf = (agentId: string | null): string => agents.find((a) => a.id === agentId)?.name ?? "An agent";
  const paid = paidTotalCents(report.payouts);
  // An empty window shows one empty state in place of the empty sections.
  const quiet =
    report.bids.length === 0 &&
    report.wins.length === 0 &&
    report.verified.length === 0 &&
    report.rejected.length === 0 &&
    report.payouts.length === 0 &&
    report.gradeChanges.length === 0 &&
    report.preApprovals.length === 0;

  return (
    <section className="spec-report" aria-labelledby="spec-report-title">
      <div className="spec-exam-head">
        <h2 id="spec-report-title" className="spec-h2">
          While you were away
        </h2>
        {report.sandbox && <span className="sandbox">PayPal sandbox</span>}
      </div>
      <p className="muted">Since {utc(report.since)}</p>

      <div className="spec-stats">
        <StatTile label="Bids" value={report.bids.length} />
        <StatTile label="Won" value={report.wins.length} />
        <StatTile label="Verified" value={report.verified.length} />
        <StatTile label="Rejected" value={report.rejected.length} />
        <StatTile label="Paid out" value={usd(paid)} note={report.sandbox ? "Sandbox payouts" : undefined} />
      </div>

      {quiet ? (
        <EmptyState inline>
          Nothing ran in the last 24 hours. Turn on autopilot on the standing orders step to let your agent work on its own.
        </EmptyState>
      ) : (
        <>
          <EntryList title="Bids" entries={report.bids} nameOf={nameOf} />
          <EntryList title="Won" entries={report.wins} nameOf={nameOf} />
          <EntryList title="Verified" entries={report.verified} nameOf={nameOf} />
          <EntryList title="Rejected" entries={report.rejected} nameOf={nameOf} />

          <section className="card pad spec-report-sec" aria-labelledby="spec-payouts-title">
            <h3 id="spec-payouts-title" className="spec-h3">
              Paid out
            </h3>
            {report.payouts.length === 0 ? (
              <p className="muted">No payouts in this window.</p>
            ) : (
              <ul className="spec-list">
                {report.payouts.map((p) => (
                  <li key={p.reference}>
                    <span className="mono">{p.reference}</span>
                    <span className="num">{usd(p.amountCents)}</span>
                    <span className="muted">for job {shortId(p.jobId)}</span>
                    <small className="num muted">{utc(p.at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card pad spec-report-sec" aria-labelledby="spec-grades-title">
            <h3 id="spec-grades-title" className="spec-h3">
              Grade changes
            </h3>
            {report.gradeChanges.length === 0 ? (
              <p className="muted">No grade changes in this window.</p>
            ) : (
              <ul className="spec-list">
                {report.gradeChanges.map((g) => (
                  <li key={`${g.at}-${g.agentId ?? ""}`}>
                    <span>{nameOf(g.agentId)}</span>
                    <span className="num">{gradeChangeWords(g.delta)}</span>
                    <small className="num muted">{utc(g.at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <EntryList title="Pre-approved submits" entries={report.preApprovals} nameOf={nameOf} />
        </>
      )}
    </section>
  );
}

function EntryList({
  title,
  entries,
  nameOf,
}: {
  readonly title: string;
  readonly entries: readonly ReportEntry[];
  readonly nameOf: (agentId: string | null) => string;
}) {
  return (
    <section className="card pad spec-report-sec">
      <h3 className="spec-h3">{title}</h3>
      {entries.length === 0 ? (
        <p className="muted">None in this window.</p>
      ) : (
        <ul className="spec-list">
          {entries.map((entry, i) => (
            <li key={`${entry.at}-${entry.jobId ?? i}`}>
              <span>{entryTitle(entry, "Job")}</span>
              <span className="muted">{nameOf(entry.agentId)}</span>
              <small className="num muted">{utc(entry.at)}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
