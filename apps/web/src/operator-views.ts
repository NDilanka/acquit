import type { BidView, CreditAccountView, JobView, OperatorEscrowRow, OperatorView, ReceiptRow } from "./api-types.ts";
import { relativeTime } from "./time.ts";

/** Every bid on a job, the operators' and the House's. A job's count shows on its card. */
export function bidCount(job: Pick<JobView, "bids">): number {
  return job.bids.operators.length + (job.bids.house ? 1 : 0);
}

/** The operator's own bid on a job, when it has one. */
export function ownBid(job: Pick<JobView, "bids">, operatorId: string): BidView | null {
  return job.bids.operators.find((b) => b.operator === operatorId) ?? null;
}

/** My bids owns the list of jobs the operator already bid on, so Find work has no tab for it. */
export type FindTab = "best" | "recent";
export const FIND_TABS: readonly { readonly value: FindTab; readonly label: string }[] = [
  { value: "best", label: "Best matches" },
  { value: "recent", label: "Most recent" },
];

export type BudgetRange = "any" | "under100" | "100to400" | "over400";
export type DeadlineRange = "any" | "under3" | "under7";
export type BidRange = "any" | "none" | "few" | "many";
export type FindFilters = {
  readonly budget: BudgetRange;
  readonly deadline: DeadlineRange;
  readonly bids: BidRange;
  readonly fundedOnly: boolean;
};
export const NO_FILTERS: FindFilters = { budget: "any", deadline: "any", bids: "any", fundedOnly: false };

/** Below this many open jobs a filter column is noise: a new workspace holds two starter jobs. */
export const FILTERS_FROM_OPEN_JOBS = 6;

export function showsFilters(jobs: readonly Pick<JobView, "status">[]): boolean {
  return jobs.filter((job) => job.status === "OPEN").length >= FILTERS_FROM_OPEN_JOBS;
}

export type BidBlocker = "agent" | "payouts" | "credits";

/** The first thing that stops the operator from bidding, in the order it must be fixed, or null when a bid can go. */
export function bidBlocker(input: {
  readonly agents: readonly unknown[];
  readonly payouts: OperatorView["payouts"];
  readonly credits: Pick<CreditAccountView, "available">;
  readonly bidCost: number;
}): BidBlocker | null {
  if (input.agents.length === 0) return "agent";
  if (input.payouts !== "READY") return "payouts";
  if (input.credits.available < input.bidCost) return "credits";
  return null;
}

/** The ready-to-bid strip's sentence for a blocker. The agent line names the CLI command until agents can be added in the app. */
export function blockerLine(blocker: BidBlocker, nextGrantAt: string, now: number): string {
  switch (blocker) {
    case "agent":
      return "A bid needs an agent. Run acquit agent create in your terminal.";
    case "payouts":
      return "Connect PayPal payouts before you bid.";
    case "credits":
      return `You have no bid credits left this week. New credits arrive ${relativeTime(nextGrantAt, now)}.`;
  }
}

const DAY_MS = 86_400_000;

function inBudget(cents: number, range: BudgetRange): boolean {
  switch (range) {
    case "any":
      return true;
    case "under100":
      return cents < 10_000;
    case "100to400":
      return cents >= 10_000 && cents <= 40_000;
    case "over400":
      return cents > 40_000;
  }
}

function inDeadline(job: Pick<JobView, "deliveryEndsAt">, range: DeadlineRange, now: number): boolean {
  if (range === "any") return true;
  const left = Date.parse(job.deliveryEndsAt) - now;
  return range === "under3" ? left < 3 * DAY_MS : left < 7 * DAY_MS;
}

function inBids(count: number, range: BidRange): boolean {
  switch (range) {
    case "any":
      return true;
    case "none":
      return count === 0;
    case "few":
      return count >= 1 && count <= 4;
    case "many":
      return count >= 5;
  }
}

function matchesFilters(job: JobView, filters: FindFilters, now: number): boolean {
  return (
    inBudget(job.budget, filters.budget) &&
    inDeadline(job, filters.deadline, now) &&
    inBids(bidCount(job), filters.bids) &&
    (!filters.fundedOnly || job.escrow === "HELD")
  );
}

/** A title, or the repository and issue number, contains the search text. Case does not matter. */
function matchesQuery(job: JobView, query: string): boolean {
  if (query === "") return true;
  if (job.title.toLowerCase().includes(query)) return true;
  const issue = job.contract ? `${job.contract.repository} #${job.contract.issue}` : "";
  return issue.toLowerCase().includes(query);
}

/**
 * The Find work list. It holds open jobs in the order the API serves them, which is newest first; the job view
 * carries no creation time to sort by. "Best matches" leaves out the jobs the operator already bid on.
 */
export function findJobs(
  jobs: readonly JobView[],
  options: { readonly operatorId: string; readonly tab: FindTab; readonly query: string; readonly filters: FindFilters; readonly now: number },
): JobView[] {
  const query = options.query.trim().toLowerCase();
  return jobs
    .filter((job) => job.status === "OPEN")
    .filter((job) => options.tab !== "best" || ownBid(job, options.operatorId) === null)
    .filter((job) => matchesQuery(job, query))
    .filter((job) => matchesFilters(job, options.filters, options.now));
}

/** The job's own line for a card: the escrow is named only once it holds. */
export function escrowLine(job: Pick<JobView, "escrow">): string {
  return job.escrow === "HELD" ? "Escrow funded through PayPal" : "Client pays into escrow on accept";
}

/** "Due in 5 days", or "Deadline passed" once the time is gone. */
export function dueLine(job: Pick<JobView, "deliveryEndsAt">, now: number): string {
  return Date.parse(job.deliveryEndsAt) <= now ? "Deadline passed" : `Due ${relativeTime(job.deliveryEndsAt, now)}`;
}

export type WorkTab = "active" | "delivery" | "review" | "finished";
export const WORK_TABS: readonly { readonly value: WorkTab; readonly label: string }[] = [
  { value: "active", label: "Active" },
  { value: "delivery", label: "Needs delivery" },
  { value: "review", label: "Awaiting review" },
  { value: "finished", label: "Finished" },
];

function isFinished(job: Pick<JobView, "status">): boolean {
  return job.status === "PAID" || job.status === "REFUNDED" || job.status === "CLOSED";
}

/** Contracts: Active holds every job not yet finished. Needs delivery is the operator's turn; Awaiting review is the client's. */
export function workMatches(job: Pick<JobView, "status" | "phase">, tab: WorkTab): boolean {
  switch (tab) {
    case "active":
      return !isFinished(job);
    case "delivery":
      return job.status === "IN_PROGRESS" && job.phase === "READY";
    case "review":
      return job.status === "VERIFIED";
    case "finished":
      return isFinished(job);
  }
}

export type BidTab = "pending" | "accepted" | "closed";
export const BID_TABS: readonly { readonly value: BidTab; readonly label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "closed", label: "Declined or closed" },
];

export function bidTab(status: BidView["status"]): BidTab {
  switch (status) {
    case "PENDING":
      return "pending";
    case "CHOSEN":
    case "ACCEPTED":
      return "accepted";
    case "NOT_SELECTED":
    case "RETURNED":
      return "closed";
  }
}

/** A pending bid on a job that is no longer open is closed, so it sits with the declined bids and reads Closed. */
export function bidTabFor(bid: BidView, job: Pick<JobView, "status">): BidTab {
  return bid.status === "PENDING" && job.status !== "OPEN" ? "closed" : bidTab(bid.status);
}

const BID_PILL: Record<BidView["status"], { readonly label: string; readonly tone: "open" | "ok" | "new" }> = {
  PENDING: { label: "Pending", tone: "open" },
  CHOSEN: { label: "Accepted", tone: "ok" },
  ACCEPTED: { label: "Accepted", tone: "ok" },
  NOT_SELECTED: { label: "Declined", tone: "new" },
  RETURNED: { label: "Declined", tone: "new" },
};

export function bidPill(status: BidView["status"]): { readonly label: string; readonly tone: "open" | "ok" | "new" } {
  return BID_PILL[status];
}

/** A pending bid goes stale when its job is no longer open: the pill then says the bid is closed. */
export function bidPillFor(bid: BidView, job: Pick<JobView, "status">): { readonly label: string; readonly tone: "open" | "ok" | "new" } {
  if (bid.status === "PENDING" && job.status !== "OPEN") return { label: "Closed", tone: "new" };
  return bidPill(bid.status);
}

export type Pipeline = { readonly held: number; readonly verifying: number; readonly awaiting: number; readonly paid: number };

/**
 * The four stages of the operator's money, in cents at the operator's net. Escrow rows sort into a stage by the job
 * they belong to; paid is the sum of the receipts.
 */
export function earningsPipeline(
  jobs: readonly Pick<JobView, "id" | "status" | "phase">[],
  escrow: readonly OperatorEscrowRow[],
  receipts: readonly Pick<ReceiptRow, "paid">[],
): Pipeline {
  const byId = new Map(jobs.map((job) => [job.id, job] as const));
  const held = (stage: (job: Pick<JobView, "status" | "phase">) => boolean) =>
    escrow.reduce((sum, row) => {
      const job = byId.get(row.jobId);
      return job && stage(job) ? sum + row.cents : sum;
    }, 0);
  return {
    held: held((j) => j.status === "IN_PROGRESS" && j.phase === "READY"),
    verifying: held((j) => j.status === "IN_PROGRESS" && j.phase === "VERIFYING"),
    awaiting: held((j) => j.status === "VERIFIED" && (j.phase === "AWAITING_CLIENT" || j.phase === "DISPUTED")),
    paid: receipts.reduce((sum, row) => sum + (row.paid ?? 0), 0),
  };
}

/** The PayPal line on the operator's pages, in plain words. */
export function payoutLine(payouts: OperatorView["payouts"]): string {
  switch (payouts) {
    case "READY":
      return "Connected. Released payouts go to your PayPal account.";
    case "AWAITING_CONSENT":
      return "Waiting for you to approve PayPal payouts.";
    case "NOT_STARTED":
      return "Not connected. Connect PayPal payouts before you bid.";
  }
}
