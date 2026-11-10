import type { ReactNode } from "react";
import { useRouter } from "../../router";
import { useSession } from "../../session";
import { ErrorNote } from "../../ui";
import { AgentPanel, AgentPicker, useOwner } from "./OwnerPanel";
import { OwnerPageSkeleton } from "./OwnerLoading";
import { provenanceWords } from "./view";
import "./specialists.css";
import "./owner.css";

export function LoadFailed({ error, onRetry, primary = false }: { readonly error: unknown; readonly onRetry: () => void; primary?: boolean }) {
  return <div className="load-failed"><ErrorNote error={error} /><button type="button" className={primary ? "btn" : "btn secondary"} onClick={onRetry}>Try again</button></div>;
}

export function SpecialistPage({ step, lead, operatorOnly = true, children, gradeDelta, provenance }: {
  step?: number; agentId?: string; lead: string; operatorOnly?: boolean; children: ReactNode; gradeDelta?: number; provenance?: string;
}) {
  const { user } = useSession();
  const { location } = useRouter();
  const owner = useOwner();
  if (operatorOnly && user.role !== "OPERATOR") return null;
  if (owner.agents === null || owner.selectionPending) return owner.error !== null
    ? <section className="agent-picker"><h1>Your agents are unavailable</h1><LoadFailed error={owner.error} onRetry={owner.reload} primary /></section>
    : <OwnerPageSkeleton path={location.path} step={step} />;
  if (step && step > 1 && step < 5 && !owner.agent) return <AgentPicker agents={owner.agents} requestedId={owner.requestedId} base={location.path.replace(/\/[^/]+$/, "") === "/specialists" ? location.path : location.path.slice(0, location.path.lastIndexOf("/"))} />;
  if (!step) return <div className="spec owner-leaderboard"><h1>Leaderboard</h1><p className="muted">{lead}</p>{children}</div>;
  return <AgentPanel agent={owner.agent} step={step} gradeDelta={gradeDelta}
    provenance={provenance ?? (owner.provenance ? `${owner.agent?.seeded ? "Seeded · " : ""}${owner.provenance}` : provenanceWords(null, owner.agent?.task === "print-fdm" || owner.agent?.task === "laser-cut", owner.agent?.seeded) || (owner.agent?.sample ? "Sample agent" : ""))}>
    <div className="spec">{children}</div>
  </AgentPanel>;
}
