import assert from "node:assert/strict";
import { test } from "node:test";
import type { BidView } from "./api-types.ts";
import type { TimelineJob } from "./job-timeline.ts";
import {
  bidBlocker,
  bidCount,
  bidPillFor,
  bidTab,
  bidTabFor,
  dueLine,
  earningsPipeline,
  blockerLine,
  escrowLine,
  FIND_TABS,
  findJobs,
  NO_FILTERS,
  ownBid,
  payoutLine,
  showsFilters,
  workMatches,
  type FindFilters,
} from "./operator-views.ts";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const DAY = 86_400_000;
const ME = "op_devon";

function bid(over: Partial<BidView>): BidView {
  return {
    id: "bid_1",
    operator: "op_other",
    handle: "other",
    label: "INDEPENDENT",
    price: 40000,
    eta: 48,
    agent: "ts-bugfixer",
    runner: "codex",
    pitch: "One fix and a test.",
    paidReceipts: 0,
    houseLine: null,
    status: "PENDING",
    ...over,
  };
}

function job(over: Partial<TimelineJob>): TimelineJob {
  return {
    id: "job_a",
    title: "Fix rounding in EUR invoices",
    status: "OPEN",
    phase: "BIDDING",
    checkoutPhase: null,
    budget: 50000,
    deliveryEndsAt: new Date(NOW + 5 * DAY).toISOString(),
    bids: { operators: [], house: null },
    client: null,
    lockedTo: null,
    viewerCanApprove: false,
    viewerCanDispute: false,
    dispute: null,
    arbiterNote: null,
    providerDispute: null,
    releaseAuthority: null,
    refundReason: null,
    escrow: "NONE",
    approveUrl: null,
    ledger: [],
    attempts: { used: 0, left: 3, last: null, reasons: [], history: [], pending: null, failure: null },
    reviewEndsAt: null,
    pullRequest: null,
    mergeCommit: null,
    merge: null,
    release: null,
    receipt: null,
    contract: null,
    funding: "card",
    clockShiftMs: 0,
    ...over,
  };
}

const OPEN_NEW = job({ id: "job_new", title: "Fix the date parser" });
const OPEN_MINE = job({ id: "job_mine", title: "Cache the EUR rate", bids: { operators: [bid({ operator: ME, handle: "devon", price: 30000 })], house: null } });
const OPEN_OLD = job({
  id: "job_old",
  title: "Trim the CSV export",
  budget: 9000,
  deliveryEndsAt: new Date(NOW + 2 * DAY).toISOString(),
  contract: { repository: "NDilanka/acquit-demo", issue: 12, frozenAt: "a", frozenTestPath: "t", frozenTests: 40, hiddenTests: 8, hiddenManifest: "m", protectedPaths: [] },
});
const JOBS = [OPEN_NEW, OPEN_MINE, OPEN_OLD] as const;

function find(tab: "best" | "recent", over: Partial<{ query: string; filters: FindFilters }> = {}): string[] {
  return findJobs(JOBS, { operatorId: ME, tab, query: over.query ?? "", filters: over.filters ?? NO_FILTERS, now: NOW }).map((j) => j.id);
}

test("Find work has two tabs, Best matches and Most recent; My bids lists the jobs already bid on", () => {
  assert.deepEqual(FIND_TABS.map((t) => t.label), ["Best matches", "Most recent"]);
});

test("best matches leaves out the jobs the operator already bid on; most recent keeps them", () => {
  assert.deepEqual(find("best"), ["job_new", "job_old"]);
  assert.deepEqual(find("recent"), ["job_new", "job_mine", "job_old"]);
});

test("the filter column shows from 6 open jobs, and closed jobs do not count toward it", () => {
  const open = (n: number) => Array.from({ length: n }, () => ({ status: "OPEN" as const }));
  assert.equal(showsFilters(open(2)), false);
  assert.equal(showsFilters(open(5)), false);
  assert.equal(showsFilters(open(6)), true);
  assert.equal(showsFilters([...open(5), { status: "PAID" }, { status: "CLOSED" }]), false);
});

test("the ready strip names the first blocker: no agent, then payouts, then credits", () => {
  const ready = { agents: [{}], payouts: "READY", credits: { available: 30 }, bidCost: 10 } as const;
  assert.equal(bidBlocker(ready), null);
  assert.equal(bidBlocker({ ...ready, agents: [], payouts: "NOT_STARTED", credits: { available: 0 } }), "agent");
  assert.equal(bidBlocker({ ...ready, payouts: "AWAITING_CONSENT", credits: { available: 0 } }), "payouts");
  assert.equal(bidBlocker({ ...ready, credits: { available: 9 } }), "credits");
  assert.equal(bidBlocker({ ...ready, credits: { available: 10 } }), null);
});

test("the ready strip's sentences, with the credit return in relative time", () => {
  const grant = new Date(NOW + 2 * DAY).toISOString();
  assert.equal(blockerLine("agent", grant, NOW), "A bid needs an agent. Run acquit agent create in your terminal.");
  assert.equal(blockerLine("payouts", grant, NOW), "Connect PayPal payouts before you bid.");
  assert.equal(blockerLine("credits", grant, NOW), "You have no bid credits left this week. New credits arrive in 2 days.");
});

test("only open jobs are listed, in the order the API serves them", () => {
  const funded = job({ id: "job_paid", status: "PAID", phase: "PAID" });
  const found = findJobs([funded, OPEN_NEW], { operatorId: ME, tab: "recent", query: "", filters: NO_FILTERS, now: NOW });
  assert.deepEqual(found.map((j) => j.id), ["job_new"]);
});

test("the search matches a title, or the repository and issue number, in any case", () => {
  assert.deepEqual(find("recent", { query: "  EUR " }), ["job_mine"]);
  assert.deepEqual(find("recent", { query: "acquit-demo #12" }), ["job_old"]);
  assert.deepEqual(find("recent", { query: "nothing here" }), []);
});

test("the budget ranges split under 100, 100 to 400 (inclusive), and over 400", () => {
  const atFour = job({ id: "job_four", budget: 40000 });
  const budgets = (range: FindFilters["budget"]) =>
    findJobs([OPEN_NEW, OPEN_OLD, atFour], { operatorId: ME, tab: "recent", query: "", filters: { ...NO_FILTERS, budget: range }, now: NOW }).map((j) => j.id);
  assert.deepEqual(budgets("under100"), ["job_old"]);
  assert.deepEqual(budgets("100to400"), ["job_four"]);
  assert.deepEqual(budgets("over400"), ["job_new"]);
});

test("the deadline filter keeps jobs due inside 3 days, or inside 7", () => {
  assert.deepEqual(find("recent", { filters: { ...NO_FILTERS, deadline: "under3" } }), ["job_old"]);
  assert.deepEqual(find("recent", { filters: { ...NO_FILTERS, deadline: "under7" } }), ["job_new", "job_mine", "job_old"]);
});

test("the bid counts split 0, 1 to 4, and 5 or more", () => {
  assert.deepEqual(find("recent", { filters: { ...NO_FILTERS, bids: "none" } }), ["job_new", "job_old"]);
  assert.deepEqual(find("recent", { filters: { ...NO_FILTERS, bids: "few" } }), ["job_mine"]);
  assert.deepEqual(find("recent", { filters: { ...NO_FILTERS, bids: "many" } }), []);
});

test("the funded filter keeps only jobs whose escrow holds", () => {
  const funded = job({ id: "job_funded", escrow: "HELD" });
  const found = findJobs([OPEN_NEW, funded], { operatorId: ME, tab: "recent", query: "", filters: { ...NO_FILTERS, fundedOnly: true }, now: NOW });
  assert.deepEqual(found.map((j) => j.id), ["job_funded"]);
});

test("a bid count includes the House, and an operator finds its own bid", () => {
  const withHouse = job({ bids: { operators: [bid({ operator: ME })], house: bid({ id: "bid_house", operator: "op_house", label: "HOUSE" }) } });
  assert.equal(bidCount(withHouse), 2);
  assert.equal(ownBid(withHouse, ME)?.id, "bid_1");
  assert.equal(ownBid(withHouse, "op_nobody"), null);
});

test("an escrow line names PayPal only once the escrow holds", () => {
  assert.equal(escrowLine({ escrow: "HELD" }), "Escrow funded through PayPal");
  assert.equal(escrowLine({ escrow: "NONE" }), "Client pays into escrow on accept");
});

test("a due line counts down, and says so once the time is gone", () => {
  assert.equal(dueLine({ deliveryEndsAt: new Date(NOW + 5 * DAY).toISOString() }, NOW), "Due in 5 days");
  assert.equal(dueLine({ deliveryEndsAt: new Date(NOW - DAY).toISOString() }, NOW), "Deadline passed");
});

test("contracts split the operator's jobs into Active, Needs delivery, Awaiting review, and Finished", () => {
  const ready = { status: "IN_PROGRESS", phase: "READY" } as const;
  const verified = { status: "VERIFIED", phase: "AWAITING_CLIENT" } as const;
  const paid = { status: "PAID", phase: "PAID" } as const;
  assert.equal(workMatches(ready, "delivery"), true);
  assert.equal(workMatches(ready, "active"), true);
  assert.equal(workMatches(ready, "finished"), false);
  assert.equal(workMatches(verified, "review"), true);
  assert.equal(workMatches(verified, "delivery"), false);
  assert.equal(workMatches(paid, "active"), false);
  assert.equal(workMatches(paid, "finished"), true);
});

test("a bid's status maps to one tab and one pill, and a pending bid on a closed job reads Closed", () => {
  assert.equal(bidTab("PENDING"), "pending");
  assert.equal(bidTab("ACCEPTED"), "accepted");
  assert.equal(bidTab("RETURNED"), "closed");
  assert.equal(bidTabFor(bid({ status: "PENDING" }), { status: "OPEN" }), "pending");
  assert.equal(bidTabFor(bid({ status: "PENDING" }), { status: "PAID" }), "closed");
  assert.equal(bidTabFor(bid({ status: "ACCEPTED" }), { status: "PAID" }), "accepted");
  assert.deepEqual(bidPillFor(bid({ status: "PENDING" }), { status: "OPEN" }), { label: "Pending", tone: "open" });
  assert.deepEqual(bidPillFor(bid({ status: "PENDING" }), { status: "PAID" }), { label: "Closed", tone: "new" });
  assert.deepEqual(bidPillFor(bid({ status: "NOT_SELECTED" }), { status: "PAID" }), { label: "Declined", tone: "new" });
});

test("the earnings pipeline sorts each escrow hold into its stage and sums the receipts", () => {
  const jobs = [
    { id: "j_ready", status: "IN_PROGRESS", phase: "READY" },
    { id: "j_verify", status: "IN_PROGRESS", phase: "VERIFYING" },
    { id: "j_await", status: "VERIFIED", phase: "AWAITING_CLIENT" },
    { id: "j_done", status: "PAID", phase: "PAID" },
  ] as const;
  const escrow = [
    { jobId: "j_ready", cents: 36000 },
    { jobId: "j_verify", cents: 18000 },
    { jobId: "j_await", cents: 9000 },
    { jobId: "j_gone", cents: 99999 },
  ];
  const receipts = [{ paid: 45000 }, { paid: null }];
  assert.deepEqual(earningsPipeline(jobs, escrow, receipts), { held: 36000, verifying: 18000, awaiting: 9000, paid: 45000 });
});

test("the PayPal line names the state in plain words", () => {
  assert.equal(payoutLine("READY"), "Connected. Released payouts go to your PayPal account.");
  assert.equal(payoutLine("AWAITING_CONSENT"), "Waiting for you to approve PayPal payouts.");
  assert.equal(payoutLine("NOT_STARTED"), "Not connected. Connect PayPal payouts before you bid.");
});
