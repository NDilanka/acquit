import { useId, useState } from "react";
import { Link } from "../../router.tsx";
import { useToast } from "../../toast.tsx";
import { EmptyState, ErrorNote, Segmented, SkeletonCard, Spinner } from "../../ui.tsx";
import { AgentCard } from "./AgentCard.tsx";
import { specialists } from "./client.ts";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { SpecialistAgent, StandingOrders } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import {
  DEFAULT_FORM,
  autopilotCopy,
  autopilotSupported,
  formFrom,
  formProblems,
  ordersDirty,
  pickAgent,
  toOrdersInput,
  type OrdersForm,
} from "./view.ts";

const CONCURRENT = [1, 2, 3] as const;
const DAILY_CAP = [1, 2, 3] as const;

export function StandingOrdersPage({ agentId }: { readonly agentId?: string }) {
  return (
    <SpecialistPage
      step={3}
      agentId={agentId}
      lead="Set the lowest price, how many jobs run at once and the daily cap. Autopilot runs the agent on its own within that cap."
    >
      <StandingOrdersBody agentId={agentId} />
    </SpecialistPage>
  );
}

function StandingOrdersBody({ agentId }: { readonly agentId?: string }) {
  const agents = useLoad(() => specialists.agents(), "agents");
  if (agents.data === null) {
    return agents.error !== null ? (
      <LoadFailed error={agents.error} onRetry={agents.reload} />
    ) : (
      <SkeletonCard lines={4} />
    );
  }
  const agent = pickAgent(agents.data, agentId);
  if (agent === null) {
    return (
      <EmptyState action={{ to: "/specialists", label: "Plug in an agent" }}>
        No agent to set orders for yet. Plug one in first.
      </EmptyState>
    );
  }
  return <OrdersForAgent key={agent.id} agent={agent} />;
}

function OrdersForAgent({ agent }: { readonly agent: SpecialistAgent }) {
  // A null answer means the agent has no orders yet, so it is wrapped to tell it apart from "not read yet".
  const orders = useLoad(async () => ({ orders: await specialists.standingOrders(agent.id) }), agent.id);
  if (orders.data === null) {
    return orders.error !== null ? (
      <LoadFailed error={orders.error} onRetry={orders.reload} />
    ) : (
      <SkeletonCard lines={5} />
    );
  }
  return <OrdersEditor agent={agent} initial={orders.data.orders} />;
}

function OrdersEditor({ agent, initial }: { readonly agent: SpecialistAgent; readonly initial: StandingOrders | null }) {
  const toast = useToast();
  const priceId = useId();
  const switchId = useId();
  const [saved, setSaved] = useState<StandingOrders | null>(initial);
  const [form, setForm] = useState<OrdersForm>(() => formFrom(initial));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  // Orders open once the agent is Acquitted. Until then the form is read-only and says why.
  const gated = !agent.acquitted;
  const supported = autopilotSupported(agent.runner);
  const runsOn = initial?.runsOn ?? (agent.sample !== null ? "acquit" : "owner");
  const problems = formProblems(form);
  const dirty = ordersDirty(form, saved);
  // The copy describes what is saved, so it never promises a switch that has not taken effect yet.
  const copy = autopilotCopy(saved?.autopilot ?? false, saved?.preApproveCap ?? DEFAULT_FORM.preApproveCap);

  const save = async () => {
    setTried(true);
    if (gated || formProblems(form) !== null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await specialists.saveStandingOrders(agent.id, toOrdersInput(form, runsOn));
      setSaved(next);
      toast("Standing orders saved");
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AgentCard agent={agent} />

      {gated && (
        <section className="card pad spec-gate" aria-live="polite">
          <p>Standing orders open once this agent is Acquitted.</p>
          <Link to={`/specialists/exam/${agent.id}`} className="btn secondary sm">
            Go to the exam
          </Link>
        </section>
      )}

      <section className="card pad spec-orders" aria-labelledby="spec-orders-title">
        <h2 id="spec-orders-title" className="spec-h2">
          Orders
        </h2>

        <fieldset className="form spec-form" disabled={gated}>
          <label className="field" htmlFor={priceId}>
            <span className="field-label">Lowest price (USD)</span>
            <input
              id={priceId}
              inputMode="decimal"
              value={form.priceUsd}
              aria-invalid={tried && problems?.priceUsd ? true : undefined}
              onChange={(e) => setForm({ ...form, priceUsd: e.target.value })}
            />
            <small className="muted">Autopilot bids exactly this price. Example: 40 or 40.00.</small>
            {tried && problems?.priceUsd && <small className="field-error">{problems.priceUsd}</small>}
          </label>

          <div className="field">
            <span className="field-label">Jobs at a time</span>
            <Segmented
              label="Jobs at a time"
              options={CONCURRENT.map((n) => ({ value: String(n), label: String(n) }))}
              value={String(form.maxConcurrent)}
              onChange={(v) => setForm({ ...form, maxConcurrent: Number(v) })}
            />
            <small className="muted">How many jobs your agent works on at the same time.</small>
          </div>

          <div className="field">
            <span className="field-label">Daily cap</span>
            <div className="spec-cap-row">
              <Segmented
                label="Daily cap"
                options={DAILY_CAP.map((n) => ({ value: String(n), label: String(n) }))}
                value={String(form.preApproveCap)}
                onChange={(v) => setForm({ ...form, preApproveCap: Number(v) })}
              />
              <span>submits a day</span>
            </div>
            <small className="muted">Autopilot stops at this many submits in any 24 hours.</small>
          </div>
        </fieldset>

        <div className="spec-autopilot">
          <label className="spec-switch-row" htmlFor={switchId}>
            <input
              id={switchId}
              type="checkbox"
              role="switch"
              className="spec-switch"
              checked={form.autopilot}
              disabled={gated || !supported}
              onChange={(e) => setForm({ ...form, autopilot: e.target.checked })}
            />
            <span className="spec-switch-label">Autopilot</span>
          </label>
          {!supported && <p className="muted">Autopilot runs Claude Code agents only.</p>}
          {copy.map((line) => (
            <p key={line} className={line === "You can close this tab now." ? "spec-close" : undefined}>
              {line}
            </p>
          ))}
          {dirty && <p className="muted">Not saved yet. Save to apply this.</p>}
        </div>

        {saveError !== null && <ErrorNote error={saveError} />}

        <div className="spec-actions">
          <button type="button" className="btn" disabled={gated || saving} onClick={() => void save()}>
            {saving && <Spinner />}
            {saving ? "Saving" : "Save standing orders"}
          </button>
        </div>
      </section>

      <div className="spec-next">
        <Link to={`/specialists/night/${agent.id}`} className="btn">
          Next
        </Link>
      </div>
    </>
  );
}
