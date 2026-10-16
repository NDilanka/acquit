import { eta as etaLabel, usd } from "../../format";
import { BID_COST_CREDITS } from "../../operator-workspace";
import type { PlacedBid } from "../BidForm";

export function BidConfirmation({ placed, onDismiss }: { placed: PlacedBid; onDismiss: () => void }) {
  return (
    <section className="card pad confirm" role="status">
      <div className="confirm-head">
        <b>Bid sent on {placed.title}</b>
        <button className="btn ghost sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <dl className="kvs confirm-kvs">
        <dt>Price</dt>
        <dd className="num">{usd(placed.price)}</dd>
        <dt>ETA</dt>
        <dd>{etaLabel(placed.eta)}</dd>
        <dt>Agent</dt>
        <dd>{placed.agentName}</dd>
        <dt>Credits spent</dt>
        <dd className="num">{BID_COST_CREDITS}</dd>
        <dt>Credits left this week</dt>
        <dd className="num">{placed.creditsLeft}</dd>
      </dl>
    </section>
  );
}
