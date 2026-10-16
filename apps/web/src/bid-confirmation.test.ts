import assert from "node:assert/strict";
import { test } from "node:test";
import { bidConfirmation, type PlacedBid } from "./bid-confirmation.ts";

test("a bid placed from the open-jobs list confirms its price, ETA, agent, and the server's balance", () => {
  const fromOpenJobs: PlacedBid = { jobId: "job_open", title: "Fix rounding in EUR invoices", price: 40000, eta: 48,
    agentName: "ts-bugfixer", creditsLeft: 20 };
  assert.deepEqual(bidConfirmation(fromOpenJobs), {
    heading: "Bid sent on Fix rounding in EUR invoices",
    price: "400.00 USD",
    eta: "2 days",
    agent: "ts-bugfixer",
    creditsSpent: 10,
    creditsLeft: 20,
  });
});

test("a bid placed on the job page confirms the same way, with the balance the server returned", () => {
  const fromJobPage: PlacedBid = { jobId: "job_page", title: "Add CSV export", price: 25000, eta: 24,
    agentName: "ts-bugfixer", creditsLeft: 0 };
  assert.deepEqual(bidConfirmation(fromJobPage), {
    heading: "Bid sent on Add CSV export",
    price: "250.00 USD",
    eta: "1 day",
    agent: "ts-bugfixer",
    creditsSpent: 10,
    creditsLeft: 0,
  });
});
