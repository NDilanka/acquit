import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import { Link, useRouter } from "../../router";
import { match } from "../../route";
import type { Session } from "../../session";
import { specialists } from "./client";
import type { SpecialistAgent, StandingOrders } from "./types";
import { useLoad } from "./useLoad";
import { dollars, gradeChangeWords, hasLiveExam, ownerAgent, STEPS, taskLabel, SIMULATED_WORD } from "./view";

type OwnerState = {
  agents: readonly SpecialistAgent[] | null;
  error: unknown;
  reload: () => void;
  agent: SpecialistAgent | null;
  requestedId?: string;
  provenance: string;
  setProvenance: (words: string) => void;
  orders: StandingOrders | null;
  setOrders: (orders: StandingOrders | null) => void;
  drafting: boolean;
  setDrafting: (drafting: boolean) => void;
  heldCents: number | null;
  moneyError: unknown;
  reloadMoney: () => void;
  announcement: string;
  announce: (message: string) => void;
};
const Context = createContext<OwnerState | null>(null);

/** One acknowledged agent/order read shared by the shell and all owner screens. */
export function OwnerProvider({ session, children }: { session: Session | null | undefined; children: ReactNode }) {
  const { location } = useRouter();
  const load = useLoad(async () => session?.user.role === "OPERATOR" ? specialists.agents() : [], `${session?.user.handle ?? ""}:${session?.user.role ?? ""}`);
  const held = useLoad(async () => session?.user.role === "OPERATOR" ? api.escrow() : { escrow: [] }, `${session?.user.handle ?? ""}:${session?.user.role ?? ""}`);
  const route = match(location.path);
  const requestedId = ("agentId" in route ? route.agentId : undefined) ?? location.search.get("agent") ?? undefined;
  const storageKey = `acquit.ownerAgent:${session?.user.handle ?? ""}`;
  const [lastId, setLastId] = useState(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  });
  const agent = ownerAgent(load.data ?? [], requestedId, lastId);
  useEffect(() => {
    if (!agent) return;
    setLastId(agent.id);
    try { localStorage.setItem(storageKey, agent.id); } catch { /* Storage is optional. */ }
  }, [agent?.id, storageKey]);
  const [provenance, setProvenance] = useState("");
  const [announcement, announce] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [ack, setAck] = useState<{ id: string; orders: StandingOrders | null } | null>(null);
  const orders = ack?.id === agent?.id ? ack?.orders ?? null : agent?.standingOrders ?? null;
  return <Context.Provider value={{ agents: load.data, error: load.error, reload: load.reload, agent, requestedId,
    provenance, setProvenance, orders, drafting, setDrafting, announcement, announce,
    heldCents: held.data === null ? null : held.data.escrow.reduce((sum, row) => sum + row.cents, 0),
    moneyError: held.error, reloadMoney: held.reload,
    setOrders: (next) => { if (agent) setAck({ id: agent.id, orders: next }); } }}>{children}</Context.Provider>;
}

export function useOwner() {
  const state = useContext(Context);
  if (!state) throw new Error("Owner screen outside OwnerProvider");
  return state;
}

export function MoneyLine() {
  const { heldCents, moneyError, reloadMoney } = useOwner();
  return <div className="owner-money"><p>{moneyError !== null
    ? <>Could not read held money · PayPal sandbox <button type="button" className="text-button" onClick={reloadMoney}>Retry</button></>
    : heldCents === null ? "Reading held money · PayPal sandbox"
    : heldCents === 0 ? "No money held · PayPal sandbox"
    : `${dollars(heldCents)} held in your workspace · PayPal sandbox`}</p></div>;
}

/** The same identity, money and weighted track coordinates on every owner screen. */
export function AgentPanel({ agent, step, provenance, children, gradeDelta }: {
  agent: SpecialistAgent | null; step: number; provenance: string; children: ReactNode; gradeDelta?: number;
}) {
  const coming = agent !== null && !hasLiveExam(agent.task);
  return <><aside className="owner-panel" aria-label="Your agent">
    <header className="owner-bridge">
      <div className="owner-identity"><p className="owner-name">{agent?.name ?? "No agent plugged in yet"}</p>
        {agent && <div className="owner-identity-meta"><p className="owner-task">{taskLabel(agent.task)}</p>
          {coming && step !== 2 ? <p className="owner-verdict">Exam coming</p> : !coming && <p className="owner-verdict">{agent.acquitted ? "Acquitted" : "Not acquitted"}
            {step !== 2 && agent.acquitted && agent.simulated && <> · <span className="owner-honesty">{SIMULATED_WORD}</span></>}</p>}</div>}</div>
      {agent && !coming && <div className="owner-grade"><span>{agent.grade === null ? "No grade yet" : "Grade"}</span><strong key={agent.grade}>{agent.grade ?? "—"}</strong>
        {gradeDelta !== undefined && <span className="owner-delta">{gradeDelta ? `${gradeChangeWords(gradeDelta)} since you last looked` : "No change since you last looked"}</span>}</div>}
    </header>
    {agent && <MoneyLine />}
    <div className="owner-track-row">
      <nav aria-label="Agent setup"><ol className="owner-track">{STEPS.map((s) => {
        const to = s.step === 1 || s.step === 5 ? `${s.to}${agent ? `?agent=${encodeURIComponent(agent.id)}` : ""}` : `${s.to}${agent ? `/${encodeURIComponent(agent.id)}` : ""}`;
        return <li key={s.step} className={s.step < step ? "done" : s.step === step ? "current" : ""}>
          <Link to={to} aria-current={s.step === step ? "step" : undefined}><span className="track-rail" aria-hidden="true" />
            <span className="track-label"><span className="track-number" aria-hidden="true">{s.step < step ? "✓" : s.step}</span><span>{s.label}</span></span></Link>
        </li>;
      })}</ol></nav>
      <p className="owner-track-current">Step {step} of 5 · {STEPS.find(s => s.step === step)?.label}</p>
      {step !== 2 && provenance && <p className="owner-provenance">{provenance}</p>}
    </div>
    </aside><div className="owner-deck">{children}</div></>;
}

export function AgentPicker({ agents, requestedId, base }: {
  agents: readonly SpecialistAgent[]; requestedId?: string; base: string;
}) {
  return <section className="agent-picker">
    <h1>{requestedId ? "Agent not found" : agents.length ? "Choose your agent" : "Plug in your first agent"}</h1>
    <p className="muted">{requestedId ? "That agent is not in your workspace. Choose one below." : "Pick the agent for this run."}</p>
    <ul>{agents.map((agent) => <li key={agent.id}><Link className="agent-choice" to={`${base}/${encodeURIComponent(agent.id)}`}>
      <span>{agent.name}<small>{taskLabel(agent.task)} · {!hasLiveExam(agent.task) ? "Exam coming" : agent.acquitted ? "Acquitted" : "Not acquitted"}{hasLiveExam(agent.task) && agent.acquitted && agent.simulated ? ` · ${SIMULATED_WORD}` : ""}{agent.seeded ? " · Seeded" : agent.sample ? " · Sample" : ""}</small></span>
      <span>Grade {hasLiveExam(agent.task) ? agent.grade ?? "—" : "—"}</span>
    </Link></li>)}</ul>
    <Link to="/specialists" className="btn secondary">Plug in an agent</Link>
  </section>;
}
