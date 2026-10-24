import { useEffect, useState, type FormEvent } from "react";
import type { CreditAccountView, JobView, UserCommand } from "../api-types";
import { api, type AgentSummary } from "../api";
import { type PlacedBid } from "../bid-confirmation";
import { PITCH_MAX, pitchProblem } from "../bid-rules";
import { eta as etaLabel, parseUsd, usd } from "../format";
import { useIntent } from "../intent";
import { BID_COST_CREDITS } from "../operator-workspace";
import { ErrorNote, Segmented } from "../ui";

const ETAS = [24, 48, 72, 120] as const;

/**
 * A bid's fields: the price, the delivery time, the agent, and the pitch. The pitch is checked with the server's
 * own rule (bid-rules.ts), so a pitch the form sends is one the server takes.
 */
export function BidForm({ job, onPlaced }: { job: JobView; onPlaced: (placed: PlacedBid) => void }) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [credits, setCredits] = useState<CreditAccountView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [price, setPrice] = useState((job.budget / 100).toFixed(2));
  const [eta, setEta] = useState<number>(48);
  const [agentId, setAgentId] = useState("");
  const [pitch, setPitch] = useState("");
  const [tried, setTried] = useState(false);
  const intent = useIntent();

  useEffect(() => {
    api
      .operator()
      .then((r) => {
        setAgents(r.agents);
        if (r.agents[0]) setAgentId(r.agents[0].id);
      })
      .catch((e: unknown) => setLoadError(e));
    api.credits().then((r) => setCredits(r.credits), () => undefined);
  }, []);

  const cents = parseUsd(price);
  const agent = agents?.find((a) => a.id === agentId) ?? null;
  const problem = pitchProblem(pitch);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (cents === null || cents <= 0) return intent.setError("Enter a price such as 400 or 400.00.");
    if (cents > job.budget) return intent.setError(`The price must be at most the budget, ${usd(job.budget)}.`);
    if (problem) return;
    if (!agent) return intent.setError("Create an agent first: run acquit agent create in your terminal.");
    const outcome = await intent.send(JSON.stringify([job.id, cents, eta, agent.id, pitch]), (): UserCommand => ({
      type: "PlaceBid",
      jobId: job.id,
      price: cents,
      eta: eta,
      agent: agent.id,
      pitch,
    }));
    if (outcome && outcome.result.kind === "BID") {
      onPlaced({ jobId: job.id, title: job.title, price: cents, eta, agentName: agent.name, creditsLeft: outcome.result.creditsLeft });
    }
  };

  return (
    <form className="bid-form" onSubmit={(e) => void submit(e)} noValidate>
      {loadError !== null && <ErrorNote error={loadError} />}
      <label className="field">
        <span>Price (USD)</span>
        <input inputMode="decimal" value={price} aria-describedby="bid-price-hint" onChange={(e) => setPrice(e.target.value)} />
        <small id="bid-price-hint" className="muted">The budget is {usd(job.budget)}, the most you can bid.</small>
      </label>
      <div className="field">
        <span className="field-label">Delivery time</span>
        <Segmented
          label="Delivery time"
          options={ETAS.map((h) => ({ value: String(h), label: etaLabel(h) }))}
          value={String(eta)}
          onChange={(v) => setEta(Number(v))}
        />
      </div>
      <label className="field">
        <span>Agent</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {!agents && <option>Loading agents…</option>}
          {agents?.length === 0 && <option value="">No agents yet</option>}
          {agents?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.runner})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Pitch</span>
        <textarea
          rows={3}
          value={pitch}
          aria-describedby="bid-pitch-hint"
          aria-invalid={tried && problem !== null}
          onChange={(e) => setPitch(e.target.value)}
          placeholder="How the work will be done, in one sentence."
        />
        <span className="field-foot">
          <small id="bid-pitch-hint" className="muted">One sentence. It cannot be blank, and it can be at most {PITCH_MAX} characters.</small>
          <small className={`counter num${pitch.length > PITCH_MAX ? " over" : ""}`}>
            {pitch.length} / {PITCH_MAX}
          </small>
        </span>
        {tried && problem && <small className="field-error">{problem}</small>}
      </label>
      <p className="cost">
        Placing this bid spends {BID_COST_CREDITS} credits.
        {credits && ` You have ${credits.available}.`}
      </p>
      {intent.error && (
        <div className="alert" role="alert">
          <p className="alert-msg">{intent.error}</p>
        </div>
      )}
      <button type="submit" className="btn bid-submit" disabled={intent.busy || !agent}>
        {intent.busy ? "Sending…" : "Send bid"}
      </button>
    </form>
  );
}
