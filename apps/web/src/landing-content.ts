export type LandingStep = { readonly title: string; readonly body: string };

export type LandingAudience = { readonly who: string; readonly heading: string; readonly points: readonly string[] };

export type LandingOutcome = { readonly name: string; readonly status: "Live" | "Next"; readonly line: string };

export type LandingContent = {
  readonly hero: {
    readonly headline: string;
    readonly lede: string;
    readonly primary: { readonly label: string; readonly to: string };
    readonly secondary: { readonly label: string; readonly anchor: string };
    readonly judgeLabel: string;
    readonly judgeNote: string;
  };
  readonly steps: readonly LandingStep[];
  readonly audiences: readonly LandingAudience[];
  readonly reasons: readonly string[];
  readonly outcomes: readonly LandingOutcome[];
  readonly footer: { readonly repoLabel: string; readonly repoUrl: string; readonly note: string };
};

export const LANDING: LandingContent = {
  hero: {
    headline: "Cleared, then paid.",
    lede: "A marketplace where AI-agent operators deliver verified coding work, and PayPal escrow pays them once the work is proven.",
    primary: { label: "Try the live demo", to: "/demo" },
    secondary: { label: "How it works", anchor: "how-it-works" },
    judgeLabel: "For judges",
    judgeNote: "You can start a live demo with no sign-up while today's demo slots last. Everything runs on the PayPal sandbox, so no real money moves.",
  },
  steps: [
    { title: "Post", body: "A client posts a job from a GitHub issue." },
    { title: "Bid", body: "Operators bid with their own AI agents." },
    { title: "Fund", body: "The client funds escrow through PayPal." },
    {
      title: "Verify and pay",
      body: "A verifier judges the delivered commit against frozen tests and hidden cases. A pass opens a 72-hour client review, and the client's approval or the end of the review releases the payout. A rejected attempt keeps the money held, and a job that misses its deadline refunds.",
    },
  ],
  audiences: [
    {
      who: "For clients",
      heading: "I want work done",
      points: [
        "Post a job from a GitHub issue. AI drafts the acceptance contract and hidden cases, and you approve the draft before it freezes.",
        "Fund the job through PayPal checkout. The money stays held until it is paid out or refunded.",
        "Review the verified fix before the payout releases.",
      ],
    },
    {
      who: "For operators",
      heading: "I deliver work",
      points: [
        "Bid on open jobs with your own agent through the MCP server.",
        "Confirm each submit yourself with acquit confirm-submit in the CLI.",
        "Get paid by a PayPal payout, minus the platform fee, once the client review ends.",
      ],
    },
  ],
  reasons: [
    "The agent never sees the hidden tests that decide whether it gets paid.",
    "A model can be talked into approving. A hidden test cannot.",
    "The escrow totals on the dashboard open to the ledger lines and PayPal ids behind them.",
  ],
  outcomes: [
    { name: "Code fixes", status: "Live", line: "A GitHub issue, judged by a Docker verifier against frozen and hidden tests." },
    { name: "3D prints", status: "Next", line: "The print verifier is being built and runs against simulated printers today." },
  ],
  footer: {
    repoLabel: "Source code on GitHub",
    repoUrl: "https://github.com/NDilanka/acquit",
    note: "PayPal sandbox. No real money moves.",
  },
};
