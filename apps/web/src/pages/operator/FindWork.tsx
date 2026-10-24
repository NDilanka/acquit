import { useState, type ReactNode } from "react";
import { HouseNote } from "../../account-ui";
import type { BidView, CreditAccountView, JobView, OperatorView } from "../../api-types";
import type { AgentSummary } from "../../api";
import type { PlacedBid } from "../../bid-confirmation";
import { creditLine, runnerLabel, usd, utc } from "../../format";
import { Icon } from "../../icons";
import { Link } from "../../router";
import { BID_COST_CREDITS } from "../../operator-workspace";
import {
  bidBlocker,
  bidCount,
  bidPillFor,
  blockerLine,
  dueLine,
  escrowLine,
  FIND_TABS,
  findJobs,
  NO_FILTERS,
  ownBid,
  payoutLine,
  showsFilters,
  STARTER_COPY,
  starterFoot,
  type BidRange,
  type BudgetRange,
  type DeadlineRange,
  type FindFilters,
  type FindTab,
} from "../../operator-views";
import { useToast } from "../../toast";
import { useSession } from "../../session";
import { EmptyState, HouseBadge, IdChip, Modal, Segmented } from "../../ui";
import { BidForm } from "../BidForm";
import type { OperatorData } from "./OperatorPage";

/** Find work: the open jobs the operator can bid on. The bid opens in a drawer, and a placed bid is confirmed by a toast. */
export function FindWork({ data, reload }: { data: OperatorData; reload: () => Promise<void> }) {
  const toast = useToast();
  const { account } = useSession();
  const [tab, setTab] = useState<FindTab>("best");
  const [query, setQuery] = useState("");
  const [picked, setFilters] = useState<FindFilters>(NO_FILTERS);
  const [sheet, setSheet] = useState(false);
  const [bidOn, setBidOn] = useState<JobView | null>(null);

  const now = Date.now();
  const operatorId = data.operator.id;
  const filtersShown = showsFilters(data.jobs);
  const filters = filtersShown ? picked : NO_FILTERS;
  const jobs = findJobs(data.jobs, { operatorId, tab, query, filters, now });
  const searching = query.trim() !== "" || hasFilters(filters);
  const anyOpen = data.jobs.some((job) => job.status === "OPEN");

  const clear = () => {
    setQuery("");
    setFilters(NO_FILTERS);
  };

  const onPlaced = (placed: PlacedBid) => {
    setBidOn(null);
    toast(`Bid placed. ${BID_COST_CREDITS} credits spent, ${placed.creditsLeft} left.`);
    void reload();
  };

  return (
    <div className="find">
      <div className="find-toolbar" data-tour="find-search">
        <label className="find-search">
          <span className="sr-only">Search jobs</span>
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            placeholder="Search by title, repository, or issue"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Segmented label="Find work tabs" options={FIND_TABS} value={tab} onChange={setTab} round />
        {searching && (
          <button type="button" className="btn ghost sm" onClick={clear}>
            Clear
          </button>
        )}
        {filtersShown && (
          <button type="button" className="btn secondary sm find-filters-toggle" onClick={() => setSheet(true)}>
            Filters{hasFilters(filters) ? " (on)" : ""}
          </button>
        )}
      </div>

      <div className={`find-layout${filtersShown ? "" : " no-filters"}`}>
        {filtersShown && (
          <aside className="find-filters card pad" aria-label="Filters">
            <FilterPanel filters={filters} onChange={setFilters} />
          </aside>
        )}

        <div className="find-list">
          <ReadyStrip data={data} now={now} />
          {data.starters?.capped && <p className="muted starter-capped">{STARTER_COPY.capped}</p>}
          {!anyOpen ? (
            <EmptyState icon="search">No open jobs right now. New jobs show here as clients post them.</EmptyState>
          ) : jobs.length === 0 ? (
            <EmptyState icon="search">{emptyCopy(searching, filtersShown)}</EmptyState>
          ) : (
            jobs.map((job, i) => (
              <JobCard key={job.id} job={job} now={now} first={i === 0} bid={ownBid(job, operatorId)} onBid={() => setBidOn(job)} />
            ))
          )}
        </div>

        <aside className="find-info" aria-label="Bid credits, agents, and payouts">
          <CreditsCard credits={data.credits} now={now} />
          <AgentsCard agents={data.agents} />
          <PayoutsCard operator={data.operator} />
        </aside>
      </div>
      <HouseNote account={account} page="find" />

      {sheet && filtersShown && (
        <Modal
          title="Filters"
          variant="drawer"
          onClose={() => setSheet(false)}
          actions={
            <>
              <button type="button" className="btn ghost" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </button>
              <button type="button" className="btn" onClick={() => setSheet(false)}>
                Show {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
              </button>
            </>
          }
        >
          <FilterPanel filters={filters} onChange={setFilters} />
        </Modal>
      )}

      {bidOn && (
        <BidForm
          job={bidOn}
          onPlaced={onPlaced}
          frame={(form, submit) => (
            <Modal
              title="Place a bid"
              variant="drawer"
              tour="bid-drawer"
              onClose={() => setBidOn(null)}
              actions={
                <>
                  <button type="button" className="btn ghost" onClick={() => setBidOn(null)}>
                    Cancel
                  </button>
                  {submit}
                </>
              }
            >
              <div className="bid-job">
                <p className="job-title">{bidOn.title}</p>
                <p className="job-meta">
                  Budget {usd(bidOn.budget)} · {dueLine(bidOn, now)}
                </p>
              </div>
              {form}
            </Modal>
          )}
        />
      )}
    </div>
  );
}

function hasFilters(filters: FindFilters): boolean {
  return (Object.keys(NO_FILTERS) as (keyof FindFilters)[]).some((key) => filters[key] !== NO_FILTERS[key]);
}

/** The empty line says why the list is empty, so a filtered-out list is not read as no work at all. */
function emptyCopy(searching: boolean, filtersShown: boolean): string {
  if (searching) return filtersShown ? "No open job matches this search and these filters." : "No open job matches this search.";
  return "You have bid on every open job. See them under My bids.";
}

/** One line above the list, only while something stops every bid. */
function ReadyStrip({ data, now }: { data: OperatorData; now: number }) {
  const blocker = bidBlocker({ agents: data.agents, payouts: data.operator.payouts, credits: data.credits, bidCost: BID_COST_CREDITS });
  if (blocker === null) return null;
  let action: ReactNode = null;
  if (blocker === "agent") action = <CopyButton value="acquit agent create" />;
  if (blocker === "payouts" && data.operator.onboardingUrl) action = <a href={data.operator.onboardingUrl}>Connect PayPal payouts</a>;
  return (
    <div className="alert warn ready-strip" data-tour="find-ready">
      <p className="alert-msg" title={blocker === "credits" ? utc(data.credits.nextGrantAt) : undefined}>
        {blockerLine(blocker, data.credits.nextGrantAt, now)}
      </p>
      {action}
    </div>
  );
}

const BUDGETS: readonly { readonly value: BudgetRange; readonly label: string }[] = [
  { value: "any", label: "Any budget" },
  { value: "under100", label: "Under 100 USD" },
  { value: "100to400", label: "100 to 400 USD" },
  { value: "over400", label: "Over 400 USD" },
];
const DEADLINES: readonly { readonly value: DeadlineRange; readonly label: string }[] = [
  { value: "any", label: "Any deadline" },
  { value: "under3", label: "Due in under 3 days" },
  { value: "under7", label: "Due in under 7 days" },
];
const BIDS: readonly { readonly value: BidRange; readonly label: string }[] = [
  { value: "any", label: "Any number of bids" },
  { value: "none", label: "No bids yet" },
  { value: "few", label: "1 to 4 bids" },
  { value: "many", label: "5 or more bids" },
];

function FilterPanel({ filters, onChange }: { filters: FindFilters; onChange: (next: FindFilters) => void }) {
  return (
    <div className="filter-panel">
      <FilterGroup legend="Budget" name="find-budget" value={filters.budget} options={BUDGETS} onPick={(budget) => onChange({ ...filters, budget })} />
      <FilterGroup legend="Deadline" name="find-deadline" value={filters.deadline} options={DEADLINES} onPick={(deadline) => onChange({ ...filters, deadline })} />
      <FilterGroup legend="Bids so far" name="find-bids" value={filters.bids} options={BIDS} onPick={(bids) => onChange({ ...filters, bids })} />
      <label className="check">
        <input type="checkbox" checked={filters.fundedOnly} onChange={(e) => onChange({ ...filters, fundedOnly: e.target.checked })} />
        Escrow funded only
      </label>
    </div>
  );
}

function FilterGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onPick,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onPick: (value: T) => void;
}) {
  return (
    <fieldset className="filter-group">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="check">
          <input type="radio" name={name} checked={value === option.value} onChange={() => onPick(option.value)} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function JobCard({ job, now, first, bid, onBid }: { job: JobView; now: number; first: boolean; bid: BidView | null; onBid: () => void }) {
  const count = bidCount(job);
  const pill = bid ? bidPillFor(bid, job) : null;
  return (
    <article className="card job-card" data-tour={first ? "find-card" : undefined}>
      <div className="job-top">
        <Link to={`/jobs/${job.id}`} className="job-title">
          {job.title}
        </Link>
        <span className="job-budget num">Budget {usd(job.budget)}</span>
      </div>
      <p className="job-meta">
        {count === 1 ? "1 bid so far" : `${count} bids so far`} · {dueLine(job, now)}
      </p>
      <div className="job-chips">
        {job.starter && <HouseBadge>House client</HouseBadge>}
        {job.contract && <span className="chip mono">{`${job.contract.repository} #${job.contract.issue}`}</span>}
        <span className="chip">Code, hidden tests</span>
        {job.contract && <span className="chip">{`${job.contract.frozenTests} visible tests, ${job.contract.hiddenTests} hidden`}</span>}
        <IdChip value={job.id} />
      </div>
      <div className="job-foot">
        <small className="muted">{starterFoot(job, bid) ?? escrowLine(job)}</small>
        {bid && pill ? (
          <span className={`pill ${pill.tone}`}>
            Bid placed: {usd(bid.price)}, {pill.label}
          </span>
        ) : job.phase === "BIDDING" ? (
          <button type="button" className="btn sm" data-tour={first ? "find-bid" : undefined} onClick={onBid}>
            Bid
          </button>
        ) : (
          <small className="muted">Not taking bids right now</small>
        )}
      </div>
    </article>
  );
}

function CreditsCard({ credits, now }: { credits: CreditAccountView; now: number }) {
  return (
    <section className="card pad side-card" aria-labelledby="bid-credits" data-tour="find-credits">
      <p className="eyebrow" id="bid-credits">
        Bid credits
      </p>
      <p className="side-big num">{credits.available}</p>
      <small className="muted" title={utc(credits.nextGrantAt)}>
        {creditLine(credits, now)}
      </small>
      <small className="muted">Each bid spends {BID_COST_CREDITS} credits.</small>
    </section>
  );
}

function AgentsCard({ agents }: { agents: readonly AgentSummary[] }) {
  return (
    <section className="card pad side-card" aria-labelledby="your-agents">
      <h2 id="your-agents">Your agents</h2>
      {agents.length === 0 ? (
        <>
          <p className="muted">A bid needs an agent. Create one in your terminal:</p>
          <div className="copy-cmd">
            <code className="mono">acquit agent create</code>
            <CopyButton value="acquit agent create" />
          </div>
        </>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => (
            <li key={agent.id}>
              <b>{agent.name}</b> <span className="muted">{runnerLabel(agent.runner)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <button type="button" className="btn secondary sm" aria-label={`Copy ${value}`} onClick={copy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function PayoutsCard({ operator }: { operator: OperatorView }) {
  return (
    <section className="card pad side-card" aria-labelledby="payouts">
      <h2 id="payouts">PayPal payouts</h2>
      <p>{payoutLine(operator.payouts)}</p>
      {operator.payouts !== "READY" && operator.onboardingUrl && (
        <a className="btn secondary sm" href={operator.onboardingUrl}>
          Connect PayPal payouts
        </a>
      )}
    </section>
  );
}
