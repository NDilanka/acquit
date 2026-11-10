import { createContext, useContext, useState, type ReactNode } from "react";
import { Link, useRouter } from "../../router";
import { match } from "../../route";
import type { Session } from "../../session";
import { specialists } from "./client";
import type { SpecialistAgent, StandingOrders } from "./types";
import { useLoad } from "./useLoad";
import { dollars, hasLiveExam, pickAgent, STEPS, taskLabel, SIMULATED_WORD } from "./view";

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
};
const Context = createContext<OwnerState | null>(null);

/** One acknowledged agent/order read shared by the shell and all first-night screens. */
export function OwnerProvider({ session, children }: { session: Session | null | undefined; children: ReactNode }) {
  const { location } = useRouter();
  const load = useLoad(async () => session?.user.role === "OPERATOR" ? specialists.agents() : [], `${session?.user.handle ?? ""}:${session?.user.role ?? ""}`);
  const route = match(location.path);
  const requestedId = ("agentId" in route ? route.agentId : undefined) ?? location.search.get("agent") ?? undefined;
  const agent = pickAgent(load.data ?? [], requestedId);
  const [provenance, setProvenance] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [ack, setAck] = useState<{ id: string; orders: StandingOrders | null } | null>(null);
  const orders = ack?.id === agent?.id ? ack?.orders ?? null : agent?.standingOrders ?? null;
  return <Context.Provider value={{ agents: load.data, error: load.error, reload: load.reload, agent, requestedId,
    provenance, setProvenance, orders, drafting, setDrafting, setOrders: (next) => { if (agent) setAck({ id: agent.id, orders: next }); } }}>{children}</Context.Provider>;
}

export function useOwner() {
  const state = useContext(Context);
  if (!state) throw new Error("Owner screen outside OwnerProvider");
  return state;
}

export type MoneyState = { amountCents?: number; status: "held" | "released" | "pending" | "refunded" };
export function MoneyLine({ money }: { money?: MoneyState }) {
  return <div className="owner-money"><p>{money?.amountCents !== undefined
    ? <>{dollars(money.amountCents)} {money.status}{money.status === "held" ? " by PayPal · sandbox" : " · PayPal sandbox"}</>
    : "Money status unavailable · PayPal sandbox"}</p></div>;
}

/** The same identity, money and weighted track coordinates on every first-night screen. */
export function AgentPanel({ agent, step, provenance, money, children }: {
  agent: SpecialistAgent | null; step: number; provenance: string; money?: MoneyState; children: ReactNode;
}) {
  const coming = step === 2 && agent !== null && !hasLiveExam(agent.task);
  return <article className="owner-panel">
    <header className="owner-bridge">
      <div className="owner-identity"><p className="owner-name">{agent?.name ?? "Your agent"}</p>
        <div className="owner-identity-meta"><p className="owner-task">{agent ? taskLabel(agent.task) : "Plug in one task"}</p>
          <p className="owner-verdict">{coming ? "Exam coming" : agent?.acquitted ? "Acquitted" : "Not acquitted"}
            {!coming && agent?.acquitted && agent.simulated && <> <span className="sandbox">{SIMULATED_WORD}</span></>}</p></div></div>
      <div className="owner-grade"><strong key={agent?.grade}>{agent?.grade ?? "—"}</strong><span>Grade</span></div>
    </header>
    <MoneyLine money={money} />
    <div className="owner-track-row">
      <nav aria-label="First night"><ol className="owner-track">{STEPS.map((s) => {
        const to = s.step === 1 || s.step === 5 ? `${s.to}${agent ? `?agent=${encodeURIComponent(agent.id)}` : ""}` : `${s.to}${agent ? `/${encodeURIComponent(agent.id)}` : ""}`;
        return <li key={s.step} className={s.step < step ? "done" : s.step === step ? "current" : ""}>
          <Link to={to}><span className="track-number" aria-hidden="true">{s.step < step ? "✓" : s.step}</span>
            <span aria-current={s.step === step ? "step" : undefined}>{s.label}</span></Link>
        </li>;
      })}</ol></nav>
      <p className="owner-provenance">{provenance || "Your workspace"}</p>
    </div>
    <div className="owner-deck">{children}</div>
  </article>;
}

export function AgentPicker({ agents, requestedId, base }: {
  agents: readonly SpecialistAgent[]; requestedId?: string; base: string;
}) {
  return <section className="agent-picker">
    <h1>{requestedId ? "Agent not found" : agents.length ? "Choose your agent" : "Plug in your first agent"}</h1>
    <p className="muted">{requestedId ? "That agent is not in your workspace. Choose one below." : "Pick the agent for this run."}</p>
    <ul>{agents.map((agent) => <li key={agent.id}><Link className="agent-choice" to={`${base}/${encodeURIComponent(agent.id)}`}>
      <span>{agent.name}<small>{taskLabel(agent.task)} · {agent.acquitted ? "Acquitted" : "Not acquitted"}{agent.acquitted && agent.simulated ? ` · ${SIMULATED_WORD}` : ""}{agent.seeded ? " · Seeded" : agent.sample ? " · Sample" : ""}</small></span>
      <span>Grade {agent.grade ?? "—"}</span>
    </Link></li>)}</ul>
    <Link to="/specialists" className="btn secondary">Plug in an agent</Link>
  </section>;
}
