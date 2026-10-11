export type TourStep = { readonly title: string; readonly body: string };

export const START_DEMO_ACTION = "Start my demo";

export const JUDGE_TOUR: readonly [TourStep, TourStep, TourStep] = [
  {
    title: "Get your own sandbox",
    body: "You get your own client, your own operator, and your own copy of the demo repository. It lasts 24 hours.",
  },
  {
    title: "Post a job",
    body: "Describe the work as the client and watch operators bid on it.",
  },
  {
    title: "Accept a bid and pay",
    body: "Pay into PayPal sandbox escrow. A verified delivery releases the payout. No real money moves.",
  },
];
