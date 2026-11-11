import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import { Link, useRouter } from "../../router";
import { match } from "../../route";
import type { Session } from "../../session";
import { specialists } from "./client";
import { agentTaskLabel, completedSetup, reportWorkDates, workAgent } from "./ownerState";
import type { OwnerActivity, SpecialistAgent, StandingOrders } from "./types";
import { useLoad } from "./useLoad";
import { dollars, gradeChangeWords, hasLiveExam, ownerAgent, STEPS, SIMULATED_WORD } from "./view";

type OwnerState = {
  agents: readonly SpecialistAgent[] | null;
  error: unknown;
  reload: () => void;
  agent: SpecialistAgent | null;
  requestedId?: string;
  selectionPending: boolean;
  activity: { data: { activity: OwnerActivity | null } | null; error: unknown; reload: () => void };
  agentDetails: { data: SpecialistAgent | null; error: unknown; reload: () => void };
  recordedWork: boolean;
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
function rememberedAgent(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** One acknowledged agent/order read shared by the shell and all owner screens. */
export function OwnerProvider({ session, children }: { session: Session | null | undefined; children: ReactNode }) {
  const { location } = useRouter();
  const load = useLoad(async () => session?.user.role === "OPERATOR" ? specialists.agents() : [], `${session?.user.handle ?? ""}:${session?.user.role ?? ""}`);
  const held = useLoad(async () => session?.user.role === "OPERATOR" ? api.escrow() : { escrow: [] }, `${session?.user.handle ?? ""}:${session?.user.role ?? ""}`);
  const route = match(location.path);
  const requestedId = ("agentId" in route ? route.agentId : undefined) ?? location.search.get("agent") ?? undefined;
  const workScreen = route.name === "specialistActivity" || route.name === "specialistEarnings";
  const activity = useLoad(async () => ({ activity: session?.user.role === "OPERATOR" && workScreen
    ? await specialists.activity(50,session.user.handle) : null }), `${session?.user.handle ?? ""}:${session?.user.role ?? ""}:${workScreen}`);
  const defaultWork = requestedId === undefined && workScreen;
  const recent = useLoad(async () => ({ report: session?.user.role === "OPERATOR" && defaultWork
    ? await specialists.morningReport("1970-01-01T00:00:00.000Z") : null }), `${session?.user.handle ?? ""}:${defaultWork}`);
  const selectionPending = defaultWork && ((recent.data?.report == null && recent.error === null) || (activity.data === null && activity.error === null));
  const storageKey = `acquit.ownerAgent:${session?.user.handle ?? ""}`;
  const [remembered, setRemembered] = useState(() => ({ key:storageKey,id:rememberedAgent(storageKey) }));
  const lastId = remembered.key === storageKey ? remembered.id : rememberedAgent(storageKey);
  const agent = defaultWork ? workAgent(load.data ?? [], [...reportWorkDates(recent.data?.report ?? null),
    ...(activity.data?.activity?.activity.map(job => ({ agentId:job.agentId,at:job.updatedAt })) ?? [])])
    : ownerAgent(load.data ?? [], requestedId, lastId);
  const agentDetails = useLoad(async () => agent ? await specialists.agent(agent.id) : null, `${storageKey}:${agent?.id ?? ""}`);
  const recordedWork = !!agent && ((agentDetails.data?.id === agent.id && (agentDetails.data.record?.jobsTaken ?? 0) > 0)
    || !!activity.data?.activity?.activity.some(job => job.agentId === agent.id));
  useEffect(() => {
    if (!agent) return;
    setRemembered({ key:storageKey,id:agent.id });
    try { localStorage.setItem(storageKey, agent.id); } catch { /* Storage is optional. */ }
  }, [agent?.id, storageKey]);
  const [provenance, setProvenance] = useState("");
  const [announcement, announce] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [ack, setAck] = useState<{ id: string; orders: StandingOrders | null } | null>(null);
  useEffect(() => { setProvenance(""); setDrafting(false); setAck(null); announce(""); }, [storageKey]);
  const orders = ack?.id === agent?.id ? ack?.orders ?? null : agent?.standingOrders ?? null;
  return <Context.Provider value={{ agents: load.data, error: load.error, reload: load.reload, agent, requestedId, selectionPending, activity,
    agentDetails, recordedWork, provenance, setProvenance, orders, drafting, setDrafting, announcement, announce,
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
  const { orders, recordedWork } = useOwner();
  const coming = agent !== null && !hasLiveExam(agent.task);
  // Plug In starts a new agent: the panel introduces that agent instead of naming an existing one.
  const fresh = step === 1;
  const done = completedSetup(fresh ? null : agent, fresh ? null : orders, !fresh && recordedWork);
  return <><aside className="owner-panel" data-owner-step={step} aria-label={fresh ? "New agent" : "Your agent"}>
    <header className="owner-bridge">
      <div className="owner-identity"><p className="owner-name" title={fresh ? undefined : agent?.name}>{fresh ? "New agent" : agent?.name ?? "No agent plugged in yet"}</p>
        {agent && !fresh && <div className="owner-identity-meta"><p className="owner-task">{agentTaskLabel(agent.task)}</p>
          {coming ? <p className="owner-verdict">Exam coming</p> : <p className="owner-verdict">{agent.acquitted ? "Acquitted" : "Not acquitted"}
            {step !== 2 && agent.acquitted && agent.simulated && <> · <span className="owner-honesty">{SIMULATED_WORD}</span></>}</p>}</div>}</div>
      {!fresh && agent && !coming && <div className="owner-grade"><span>{agent.grade === null ? "No grade yet" : "Grade"}</span><strong key={agent.grade}>{agent.grade ?? "—"}</strong>
        {(step === 4 || step === 5) && <span className="owner-delta">{gradeDelta === undefined ? null : gradeDelta ? `${gradeChangeWords(gradeDelta)} in this report` : "No change in this report"}</span>}</div>}
    </header>
    <MoneyLine />
    <div className="owner-track-row">
      <nav aria-label="Agent setup"><ol className="owner-track">{STEPS.map((s) => {
        const to = s.step === 1 || s.step === 5 ? `${s.to}${agent ? `?agent=${encodeURIComponent(agent.id)}` : ""}` : `${s.to}${agent ? `/${encodeURIComponent(agent.id)}` : ""}`;
        return <li key={s.step} className={[done.has(s.step) ? "done" : "", s.step === step ? "current" : ""].filter(Boolean).join(" ")}>
          <Link to={to} aria-current={s.step === step ? "step" : undefined}><span className="track-rail" aria-hidden="true" />
            <span className="track-label"><span className="track-number" aria-hidden="true">{done.has(s.step) ? "✓" : s.step}</span><span>{s.label}{!fresh && coming && s.step === 2 ? " · coming" : ""}</span></span></Link>
        </li>;
      })}</ol></nav>
      <p className="owner-track-current">Step {step} of 5 · {STEPS.find(s => s.step === step)?.label}</p>
      <p className="owner-provenance" aria-hidden={fresh || step === 2 || !provenance ? true : undefined}>{!fresh && step !== 2 ? provenance : null}</p>
    </div>
    </aside><div className="owner-deck">{!fresh && coming && agent && <p className="spec-lead machine-honesty">{agentTaskLabel(agent.task)} · No real hardware.</p>}{children}</div></>;
}

export function AgentPicker({ agents, requestedId, base }: {
  agents: readonly SpecialistAgent[]; requestedId?: string; base: string;
}) {
  return <section className="agent-picker">
    <h1>{requestedId ? "Agent not found" : agents.length ? "Choose your agent" : "Plug in your first agent"}</h1>
    <p className="muted">{requestedId ? "That agent is not in your workspace. Choose one below." : "Pick the agent for this run."}</p>
    <ul>{agents.map((agent) => <li key={agent.id}><Link className="agent-choice" to={`${base}/${encodeURIComponent(agent.id)}`}>
      <span>{agent.name}<small>{agentTaskLabel(agent.task)} · {!hasLiveExam(agent.task) ? "Exam coming" : agent.acquitted ? "Acquitted" : "Not acquitted"}{hasLiveExam(agent.task) && agent.acquitted && agent.simulated ? ` · ${SIMULATED_WORD}` : ""}{agent.seeded ? " · Seeded" : agent.sample ? " · Sample" : ""}</small></span>
      <span>Grade {hasLiveExam(agent.task) ? agent.grade ?? "—" : "—"}</span>
    </Link></li>)}</ul>
    <Link to="/specialists" className="btn secondary">Plug in an agent</Link>
  </section>;
}
