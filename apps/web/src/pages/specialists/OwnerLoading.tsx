import { WorkSkeleton } from "./WorkTimeline.tsx";
import { STEPS } from "./view.ts";

function stepAt(path: string): number {
  if (path.startsWith("/earnings")) return 5;
  return STEPS.slice(1,4).find(step => path.startsWith(step.to))?.step ?? 1;
}

/** The pending principal and pending agent use the same bridge, money and track geometry as a ready page. */
export function OwnerPageSkeleton({ path, step = stepAt(path) }: { path: string; step?: number }) {
  return <div className="owner-loading" aria-label="Loading your workspace." aria-busy="true">
    <aside className="owner-panel" data-owner-step={step} aria-hidden="true">
      <header className="owner-bridge"><div className="owner-identity">
        <div className="owner-name"><span className="work-skeleton-line" /></div>
        <div className="owner-identity-meta"><span className="work-skeleton-line short" /></div>
      </div><div className="owner-grade"><span className="work-skeleton-line" /><span className="work-skeleton-line" />
        {(step === 4 || step === 5) && <span className="owner-delta" />}</div></header>
      <div className="owner-money"><span className="work-skeleton-line short" /></div>
      <div className="owner-track-row"><div className="owner-loading-track">{STEPS.map(s => <span key={s.step} className="track-rail" />)}</div>
        <p className="owner-track-current" /><p className="owner-provenance" /></div>
    </aside><div className="owner-deck"><OwnerBodySkeleton step={step} /></div>
  </div>;
}

export function OwnerBodySkeleton({ step }: { step: number }) {
  if (step === 5) return <section className="work-page earnings-page" aria-label="Loading earnings." aria-busy="true">
    <EarningsHeadingSkeleton /><WorkSkeleton count={3} label="Loading recorded earnings." />
  </section>;
  return <section className="owner-body-loading" aria-label="Loading page content." aria-busy="true">
    <h1 className="sr-only">Loading your workspace</h1>
    <div className="owner-loading-heading" aria-hidden="true"><span className="work-skeleton-line" /><span className="work-skeleton-line short" /></div>
    {step === 2 ? <div className="exam-record exam-loading" aria-hidden="true">
      <div className="record-heading"><span className="owner-loading-seal" /><span className="work-skeleton-line" /></div>
      <div className="record-meta"><span className="work-skeleton-line short" /></div>
      <div className="record-check-bed"><span className="work-skeleton-line" /><span className="work-skeleton-line" /></div>
    </div> : step >= 4 ? <WorkSkeleton count={step === 5 ? 3 : 5} label="Loading recorded work." />
      : <div className={`owner-form-loading step-${step}`} aria-hidden="true">{[0,1,2].map(i => <span key={i} className="work-skeleton-line" />)}</div>}
  </section>;
}

export function EarningsHeadingSkeleton() {
  return <header className="earnings-head"><div className="work-heading">
    <h1>Earnings</h1><span className="work-skeleton-line" /><span className="work-skeleton-line short" />
  </div><div className="earnings-refs"><p>PayPal sandbox · workspace earnings</p></div></header>;
}

export function RecordSkeleton() {
  return <section className="public-owner-page public-record" aria-label="Loading agent record." aria-busy="true">
    <header className="work-heading"><h1>Agent record</h1><span className="work-skeleton-line short" /></header>
    <div className="public-record-split" aria-hidden="true"><div className="public-proof record-loading">
      <span className="owner-loading-seal" /><span className="work-skeleton-line" /><span className="work-skeleton-line short" />
    </div><div className="public-record-facts record-loading"><span className="work-skeleton-line" /><span className="work-skeleton-line short" /></div></div>
  </section>;
}
