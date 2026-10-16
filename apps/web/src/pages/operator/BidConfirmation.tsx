import { bidConfirmation, type PlacedBid } from "../../bid-confirmation";

export function BidConfirmation({ placed, onDismiss }: { placed: PlacedBid; onDismiss: () => void }) {
  const view = bidConfirmation(placed);
  return (
    <section className="card pad confirm" role="status">
      <div className="confirm-head">
        <b>{view.heading}</b>
        <button className="btn ghost sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <dl className="kvs confirm-kvs">
        <dt>Price</dt>
        <dd className="num">{view.price}</dd>
        <dt>ETA</dt>
        <dd>{view.eta}</dd>
        <dt>Agent</dt>
        <dd>{view.agent}</dd>
        <dt>Credits spent</dt>
        <dd className="num">{view.creditsSpent}</dd>
        <dt>Credits left this week</dt>
        <dd className="num">{view.creditsLeft}</dd>
      </dl>
    </section>
  );
}
