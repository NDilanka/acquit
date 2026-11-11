import { useEffect, useId, useState } from "react";
import { Link, useNavigationGuard } from "../../router";
import { ErrorNote, SkeletonCard, Spinner } from "../../ui";
import { specialists } from "./client";
import { useOwner } from "./OwnerPanel";
import { LoadFailed, SpecialistPage } from "./SpecialistPage";
import type { SpecialistAgent, StandingOrders } from "./types";
import { useLoad } from "./useLoad";
import { autopilotSupported, dollars, formFrom, formProblems, hasLiveExam, ordersDirty, parsePrice, taskLabel, toOrdersInput, type OrdersForm } from "./view";

function SelectChevron() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>;
}

export function StandingOrdersPage({ agentId }: { agentId?: string }) {
  const { agent } = useOwner();
  return <SpecialistPage step={3} agentId={agentId} lead="">{agent && <OrdersForAgent key={agent.id} agent={agent} />}</SpecialistPage>;
}
function OrdersForAgent({ agent }: { agent: SpecialistAgent }) {
  const load = useLoad(async () => ({ orders: await specialists.standingOrders(agent.id) }), agent.id);
  return load.data === null ? <section><h1>Standing orders</h1>{load.error !== null ? <LoadFailed error={load.error} onRetry={load.reload} primary /> : <SkeletonCard lines={4} />}</section>
    : <OrdersEditor agent={agent} initial={load.data.orders} />;
}
function OrdersEditor({ agent, initial }: { agent: SpecialistAgent; initial: StandingOrders | null }) {
  const { orders: acknowledged, setOrders, setDrafting, announce } = useOwner();
  const id = useId();
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState<OrdersForm>(() => formFrom(initial));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [edited, setEdited] = useState(false);
  const [runsOn,setRunsOn] = useState<"owner" | "acquit">(() => initial?.runsOn ?? (agent.sample ? "acquit" : "owner"));
  const dirty = ordersDirty(form, saved) || runsOn !== (saved?.runsOn ?? (agent.sample ? "acquit" : "owner"));
  const gated = !hasLiveExam(agent.task) || !agent.acquitted;
  const problems = formProblems(form);
  const cents = parsePrice(form.priceUsd);
  useEffect(() => { setOrders(initial); }, [initial]);
  useEffect(() => {
    if (!dirty && acknowledged && acknowledged !== saved) { setSaved(acknowledged); setForm(formFrom(acknowledged)); setRunsOn(acknowledged.runsOn); }
  }, [acknowledged, dirty, saved]);
  useEffect(() => { setDrafting(dirty); return () => setDrafting(false); }, [dirty, setDrafting]);
  useNavigationGuard(edited && dirty, "Leave without saving your standing orders?");
  const change = (next: OrdersForm) => { setForm(next); setEdited(true); };
  const save = async () => {
    setTouched(true);
    if (gated || problems || saving) return;
    setSaving(true); setError(null);
    try {
      const next = await specialists.saveStandingOrders(agent.id, toOrdersInput(form, runsOn));
      setSaved(next); setOrders(next); setForm(formFrom(next)); setRunsOn(next.runsOn); setEdited(false);
      announce(next.autopilot ? "Saved. You can close this tab now." : "Saved. Autopilot is off.");
    } catch (e) { setError(e); }
    finally { setSaving(false); }
  };
  return <section className="standing-orders">
    <h1>Standing orders</h1>
    {gated ? <div className="owner-gate"><p>Pass the exam before setting orders. Bidding stays off.</p><Link to={`/specialists/exam/${agent.id}`} className="btn">Take the exam</Link></div>
      : <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <p className="orders-sentence">
          Bid on {taskLabel(agent.task).toLowerCase()} jobs from{" "}
          <span className="sentence-price"><label className="sr-only" htmlFor={`${id}-price`}>Lowest price in US dollars</label>
          <input className="sentence-control" id={`${id}-price`} inputMode="decimal" autoComplete="off" value={form.priceUsd}
            aria-describedby={`${id}-echo`} aria-invalid={touched && problems?.priceUsd ? true : undefined}
            onChange={(e) => change({ ...form, priceUsd: e.target.value })}
            onBlur={() => { setTouched(true); if (cents !== null) setForm((f) => ({ ...f, priceUsd: dollars(cents) })); }} />,{""}</span>
          {" "}<span className="sentence-select"><label className="sr-only" htmlFor={`${id}-jobs`}>Jobs at a time</label>
            <select id={`${id}-jobs`} className="sentence-control" value={form.maxConcurrent} onChange={(e) => change({ ...form, maxConcurrent: Number(e.target.value) })}>
              <option value={1}>one</option><option value={2}>two</option><option value={3}>three</option>
            </select><SelectChevron /></span> at a time.
        </p>
        <details className="orders-help orders-limits"><summary>Change limits</summary>
          {agent.sample && <label className="orders-run-location">Run on
            <select className="sentence-control" value={runsOn} onChange={event => { setRunsOn(event.target.value as "owner" | "acquit"); setEdited(true); }}>
              <option value="acquit">Acquit</option><option value="owner">My machine</option>
            </select></label>}
          <label htmlFor={`${id}-cap`}>Submits a day without asking </label><span className="sentence-select">
            <select id={`${id}-cap`} className="sentence-control" value={form.preApproveCap} onChange={(e) => change({ ...form, preApproveCap: Number(e.target.value) })}>
              <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
            </select><SelectChevron /></span>
        </details>
        {touched && problems?.priceUsd && <p className="field-error" role="alert" data-tone="fail">{problems.priceUsd}</p>}
        <p className="orders-echo" id={`${id}-echo`}>{cents !== null ? "Pending until accepted · PayPal sandbox." : "Example: 40 or 40.00."}</p>
        {(dirty || !saved?.autopilot) && <div className="orders-master">
          <div><h2>Autopilot</h2><p>{form.autopilot ? "On after saving." : "Off. Confirm each submit."}</p>
            {!autopilotSupported(agent.runner) && <p>Autopilot runs Claude Code agents only.</p>}</div>
          <button type="button" className="orders-switch" role="switch" aria-label="Autopilot" aria-checked={form.autopilot}
            disabled={!autopilotSupported(agent.runner)} onClick={() => change({ ...form, autopilot: !form.autopilot })}>
            <span className={`switch-track${form.autopilot ? " on" : ""}`} aria-hidden="true" /><span>{form.autopilot ? "On" : "Off"}</span>
          </button>
        </div>}
        {error !== null && <ErrorNote error={error} />}
        <div className="owner-actions">
          {dirty ? <><button type="submit" className="btn" disabled={saving}>{saving && <Spinner />}{saving ? "Saving…" : "Save standing orders"}</button><p>Unsaved.</p></>
            : <><Link to={`/specialists/activity/${agent.id}`} className="btn">Watch activity</Link><p>{saved?.autopilot ? "Saved." : "Saved. Autopilot is off."}</p></>}
        </div>
      </form>}
  </section>;
}
