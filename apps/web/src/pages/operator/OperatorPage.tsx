import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type AgentSummary } from "../../api";
import type { CreditAccountView, OperatorEscrowRow, OperatorView, ReceiptRow, StarterStatus } from "../../api-types";
import type { TimelineJob } from "../../job-timeline";
import { JOBS_CHANGED } from "../../operator-events";
import { useSession } from "../../session";
import { ErrorNote, NotFound, SkeletonList } from "../../ui";

/** The reads every operator page shares, fetched together so the pages never disagree about the same money. */
export type OperatorData = {
  readonly operator: OperatorView;
  readonly agents: readonly AgentSummary[];
  readonly credits: CreditAccountView;
  readonly jobs: readonly TimelineJob[];
  readonly receipts: readonly ReceiptRow[];
  readonly escrow: readonly OperatorEscrowRow[];
  /** The House client's starter jobs for this account. Null for a seeded operator. */
  readonly starters: StarterStatus | null;
};

type Load = { readonly kind: "loading" } | { readonly kind: "failed"; readonly error: unknown } | { readonly kind: "ready"; readonly data: OperatorData };

async function fetchOperatorData(): Promise<OperatorData> {
  const [jobs, credits, operator, receipts, escrow] = await Promise.all([
    api.jobs(),
    api.credits(),
    api.operator(),
    api.receipts(),
    api.escrow(),
  ]);
  return {
    operator: operator.operator,
    agents: operator.agents,
    credits: credits.credits,
    jobs: jobs.jobs,
    receipts: receipts.receipts,
    escrow: escrow.escrow,
    starters: jobs.starters ?? null,
  };
}

/**
 * Loads the operator's data, then renders the page with it. A refresh after an action keeps the data on screen
 * while it loads, so a bid placed in the drawer does not blank the list behind it.
 */
export function OperatorPage({ children }: { children: (data: OperatorData, reload: () => Promise<void>) => ReactNode }) {
  const { user } = useSession();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const reload = useCallback(async () => {
    try {
      setLoad({ kind: "ready", data: await fetchOperatorData() });
    } catch (error) {
      setLoad((prev) => (prev.kind === "ready" ? prev : { kind: "failed", error }));
    }
  }, []);

  useEffect(() => {
    if (user.role !== "OPERATOR") return;
    void reload();
    const onChanged = () => void reload();
    window.addEventListener(JOBS_CHANGED, onChanged);
    return () => window.removeEventListener(JOBS_CHANGED, onChanged);
  }, [reload, user.role]);

  if (user.role !== "OPERATOR") {
    return <NotFound signedIn title="This page is for operators" message="Switch to Operator in the sidebar to see it." />;
  }
  if (load.kind === "loading") return <SkeletonList count={3} />;
  if (load.kind === "failed") {
    return (
      <div className="load-failed">
        <ErrorNote error={load.error} />
        <button
          type="button"
          className="btn secondary sm"
          onClick={() => {
            setLoad({ kind: "loading" });
            void reload();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return <>{children(load.data, reload)}</>;
}
