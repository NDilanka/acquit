import { useEffect, useState, type FormEvent } from "react";
import type { JobView, UserCommand } from "../api-types";
import { api, ApiError, type AgentSummary } from "../api";
import { eta as etaLabel, parseUsd, usd } from "../format";
import { useIntent } from "../intent";
import { BID_COST_CREDITS } from "../operator-workspace";

const ETAS = [24, 48, 72, 120] as const;

/** A bid the server took. `creditsLeft` is the server's balance, not one the page computed. */
export type PlacedBid = {
  readonly jobId: string;
  readonly title: string;
  readonly price: number;
  readonly eta: number;
  readonly agentName: string;
  readonly creditsLeft: number;
};

export function BidForm({ job, onPlaced }: { job: JobView; onPlaced: (placed: PlacedBid) => void }) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [price, setPrice] = useState((job.budget / 100).toFixed(2));
  const [eta, setEta] = useState<number>(48);
  const [agentId, setAgentId] = useState("");
  const [pitch, setPitch] = useState("");
  const intent = useIntent();

  useEffect(() => {
    api
      .operator()
      .then((r) => {
        setAgents(r.agents);
        if (r.agents[0]) setAgentId(r.agents[0].id);
      })
      .catch((e: unknown) => setLoadError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  const cents = parseUsd(price);
  const agent = agents?.find((a) => a.id === agentId) ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (cents === null || cents <= 0) return intent.setError("Enter a price such as 400 or 400.00.");
    if (cents > job.budget) return intent.setError(`The price must be at most the budget, ${usd(job.budget)}.`);
    if (!agent) return intent.setError("Pick an agent. Create one with `acquit agent create`.");
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
    <form className="form" onSubmit={(e) => void submit(e)}>
      {loadError && <div className="alert">{loadError}</div>}
      <div className="row3">
        <label>
          <span>Price (USD)</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          <small className="muted">Budget {usd(job.budget)}</small>
        </label>
        <label>
          <span>ETA</span>
          <select value={eta} onChange={(e) => setEta(Number(e.target.value))}>
            {ETAS.map((h) => (
              <option key={h} value={h}>
                {etaLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <label>
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
      </div>
      <label>
        <span>Pitch</span>
        <textarea
          rows={2}
          value={pitch}
          onChange={(e) => setPitch(e.target.value)}
          placeholder="Describe the approach and what you will deliver."
        />
      </label>
      {intent.error && <div className="alert">{intent.error}</div>}
      <div className="act">
        <small className="muted">A bid costs {BID_COST_CREDITS} credits.</small>
        <button className="btn" disabled={intent.busy || !agent}>
          {intent.busy ? "Sending…" : "Send bid"}
        </button>
      </div>
    </form>
  );
}
