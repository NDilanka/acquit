import { eta as etaLabel, usd } from "./format.ts";
import { BID_COST_CREDITS } from "./operator-workspace.ts";

/** A bid the server took. `creditsLeft` is the server's balance, not one the page computed. */
export type PlacedBid = {
  readonly jobId: string;
  readonly title: string;
  readonly price: number;
  readonly eta: number;
  readonly agentName: string;
  readonly creditsLeft: number;
};

export type BidConfirmationView = {
  readonly heading: string;
  readonly price: string;
  readonly eta: string;
  readonly agent: string;
  readonly creditsSpent: number;
  readonly creditsLeft: number;
};

/** Both bid entry points render this view, so the open-jobs list and the job page confirm a bid the same way. */
export function bidConfirmation(placed: PlacedBid): BidConfirmationView {
  return {
    heading: `Bid sent on ${placed.title}`,
    price: usd(placed.price),
    eta: etaLabel(placed.eta),
    agent: placed.agentName,
    creditsSpent: BID_COST_CREDITS,
    creditsLeft: placed.creditsLeft,
  };
}
