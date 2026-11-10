import type { ReactNode } from "react";
import { Link } from "../../router.tsx";
import { useSession } from "../../session.tsx";
import { ErrorNote, NotFound } from "../../ui.tsx";
import { STEPS } from "./view.ts";
import "./specialists.css";

/** A failed read: the sentence, and a button to read again. */
export function LoadFailed({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <div className="load-failed">
      <ErrorNote error={error} />
      <button type="button" className="btn secondary sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** The 1 to 5 step indicator. The exam, orders and night steps keep the agent the page is about. */
export function StepIndicator({ current, agentId }: { readonly current: number; readonly agentId?: string }) {
  return (
    <nav aria-label="Steps" className="spec-steps">
      <ol>
        {STEPS.map((s) => {
          const withAgent = agentId && (s.to === "/specialists/exam" || s.to === "/specialists/orders" || s.to === "/specialists/night");
          const to = withAgent ? `${s.to}/${agentId}` : s.to;
          const state = s.step === current ? "current" : s.step < current ? "done" : "todo";
          return (
            <li key={s.step} className={`spec-step ${state}`} aria-current={s.step === current ? "step" : undefined}>
              <Link to={to}>
                <span className="spec-step-num mono">{s.step}</span>
                <span>{s.label}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The frame for every specialist screen: the step indicator and one lead sentence.
 * The shell already shows the page heading. Operator-only pages send other roles to the same notice the operator pages use.
 */
export function SpecialistPage({
  step,
  agentId,
  lead,
  operatorOnly = true,
  children,
}: {
  readonly step?: number;
  readonly agentId?: string;
  readonly lead: string;
  readonly operatorOnly?: boolean;
  readonly children: ReactNode;
}) {
  const { user } = useSession();
  if (operatorOnly && user.role !== "OPERATOR") {
    return <NotFound signedIn title="This page is for operators" message="Switch to Operator in the sidebar to see it." />;
  }
  return (
    <div className="spec">
      <div className="spec-top">
        {step !== undefined && <StepIndicator current={step} agentId={agentId} />}
      </div>
      <p className="spec-lead">{lead}</p>
      {children}
    </div>
  );
}
