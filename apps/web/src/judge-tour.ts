import type { ScenarioCard } from "./scenario-run.ts";

/** The label every scripted step carries on screen, so the scripted agent is never read as a real model. */
export const SCRIPTED_LABEL = "Scripted agent (Simulated)";

/** The six scenarios, in the order the scenario list shows them. */
export const SCENARIO_CARDS: readonly ScenarioCard[] = [
  {
    name: "verified-and-paid",
    title: "Verified and paid",
    promise: "An honest fix passes the verifier. The client approves it, and the operator is paid.",
    scripted: `${SCRIPTED_LABEL} opens the job, bids, and writes the honest fix.`,
    endStateText: "Paid. The client approved a verified fix.",
  },
  {
    name: "hidden-test-fail",
    title: "Hidden test fail",
    promise: "A fix that only copies the visible rows passes the frozen tests and fails a hidden case. The attempt is rejected.",
    scripted: `${SCRIPTED_LABEL} opens the job, bids, and writes the shortcut.`,
    endStateText: "Rejected on hidden tests. The escrow stays held.",
  },
  {
    name: "test-tamper",
    title: "Test tamper",
    promise: "A fix edits the frozen test file. The verifier refuses the change as an edit to a protected file.",
    scripted: `${SCRIPTED_LABEL} opens the job, bids, and edits the frozen test.`,
    endStateText: "Rejected for changing a protected test file. The escrow stays held.",
  },
  {
    name: "dispute-arbiter",
    title: "Dispute to arbiter",
    promise: "The client disputes a verified fix, and the arbiter upholds it. The operator is paid.",
    scripted: `${SCRIPTED_LABEL} opens the job, bids, writes the fix, and gives the arbiter's verdict.`,
    endStateText: "Paid. The arbiter upheld the delivered fix.",
  },
  {
    name: "buyer-dispute",
    title: "Buyer disputes",
    promise: "A verified job's buyer opens a PayPal dispute, the approval is held, the dispute resolves for the seller, and the job is paid.",
    scripted: `${SCRIPTED_LABEL} opens the job, bids, writes the honest fix, and approves it. The dispute is a Simulated PayPal dispute.`,
    endStateText: "Paid. The buyer's PayPal dispute resolved for the seller after the approval was held.",
  },
  {
    name: "deadline-refund",
    title: "Deadline refund",
    promise: "The delivery deadline passes with no submission, and the escrow is refunded to the client.",
    scripted: `${SCRIPTED_LABEL} opens the job and bids. Simulated time for this job moves its clock 2 days.`,
    endStateText: "Refunded. The delivery deadline passed.",
  },
];
