import type { ReactNode } from "react";
import { useRouter } from "../../router";
import { useSession } from "../../session";
import { ErrorNote, SkeletonCard } from "../../ui";
import { AgentPanel, AgentPicker, useOwner } from "./OwnerPanel";
import { provenanceWords } from "./view";
import "./specialists.css";
import "./owner.css";

export function LoadFailed({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return <div className="load-failed"><ErrorNote error={error} /><button type="button" className="btn secondary" onClick={onRetry}>Try again</button></div>;
}

export function SpecialistPage({ step, lead, operatorOnly = true, children }: {
  step?: number; agentId?: string; lead: string; operatorOnly?: boolean; children: ReactNode;
}) {
  const { user } = useSession();
  const { location } = useRouter();
  const owner = useOwner();
  if (operatorOnly && user.role !== "OPERATOR") return null;
  if (owner.agents === null) return owner.error !== null ? <LoadFailed error={owner.error} onRetry={owner.reload} /> : <SkeletonCard lines={4} />;
  if (step && step > 1 && step < 5 && !owner.agent) return <AgentPicker agents={owner.agents} requestedId={owner.requestedId} base={location.path.replace(/\/[^/]+$/, "") === "/specialists" ? location.path : location.path.slice(0, location.path.lastIndexOf("/"))} />;
  if (!step) return <div className="spec owner-floor"><h1>Floor</h1><p className="muted">{lead}</p>{children}</div>;
  return <AgentPanel agent={owner.agent} step={step}
    provenance={owner.provenance || provenanceWords(null, owner.agent?.task === "print-fdm" || owner.agent?.task === "laser-cut", owner.agent?.seeded) || (owner.agent?.sample ? "Sample agent" : "")}>
    <div className="spec">{children}</div>
  </AgentPanel>;
}
