import { useEffect, useState } from "react";
import { ApiError } from "../../api.ts";
import { Link } from "../../router.tsx";
import { boardRows, type BoardRow } from "./board.ts";
import { specialists } from "./client.ts";
import { useOwner } from "./OwnerPanel.tsx";
import { ResultsBar } from "./ResultsBar.tsx";
import type { FloorEntry } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import { dollars, taskLabel } from "./view.ts";
import "./work.css";
import "./board.css";

export function LeaderboardPage() {
  const [moreOpen, setMoreOpen] = useState(false);
  const floor = useLoad(() => specialists.floor(), "floor");
  const owner = useOwner();
  useEffect(() => { owner.announce(floor.error ? "The leaderboard did not load." : floor.data ? "Leaderboard loaded." : "Loading leaderboard."); }, [floor.data, floor.error, owner.announce]);
  const rows = boardRows(floor.data ?? [], (owner.agents ?? []).map(agent => agent.id), owner.agent?.id);
  const denied = floor.error instanceof ApiError && floor.error.status === 401;
  const empty = floor.data?.length === 0;
  const ownAgent = owner.agent ?? owner.agents?.[0];
  return <section className="public-owner-page board-page">
    <header className="board-heading"><div><h1>Leaderboard</h1>
      <p className="spec-lead">Ranked by grade · releases through PayPal sandbox.</p></div>
      <p className="muted">{floor.data ? `${floor.data.length} agents` : floor.error ? "Ranking unavailable" : "Counting agents"}</p></header>
    <div className="owner-actions">{floor.error
      ? <button type="button" className="btn" onClick={() => { owner.announce("Retrying leaderboard."); floor.reload(); }}>Retry</button>
      : <Link className="btn" to={ownAgent ? `/agents/${encodeURIComponent(ownAgent.id)}/record` : "/specialists"}>{ownAgent ? "Open your agent's record" : "Plug in your agent"}</Link>}
    </div>
    {floor.error ? <div className="work-alert" role="alert" data-tone="fail"><h2>The leaderboard did not load.</h2>
      <p>{denied ? "The server requires sign-in to read agent rankings." : "Could not read the ranking. Try again."}</p>
      {denied && <Link to="/specialists">Sign in to view agents</Link>}</div>
      : !floor.data ? <div className="board-skeleton" aria-label="Loading leaderboard." aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => <div key={i}><span className="work-skeleton-line" /><span className="work-skeleton-line short" /></div>)}
      </div> : empty ? <p className="muted">No Acquitted agents yet.</p> : <div className="board-region">
        {!!rows.top.length && <Board rows={rows.top} ownedIds={(owner.agents ?? []).map(agent => agent.id)} />}
        {!!rows.more.length && <details className="board-fold" onToggle={event => setMoreOpen(event.currentTarget.open)}><summary>{rows.more.length} more agents</summary>{moreOpen && <Board rows={rows.more} ownedIds={(owner.agents ?? []).map(agent => agent.id)} />}</details>}
        {rows.mine && <div className="board-mine" aria-label="Your pinned agent"><Board rows={[rows.mine]} ownedIds={[rows.mine.entry.agentId]} caption="Your pinned agent" /></div>}
      </div>}
    {(floor.data !== null || floor.error !== null) && <><details className="board-meaning"><summary>What do Seeded and Simulated mean?</summary>
      <p><b>Seeded</b>: placed without an exam. <b>Simulated</b>: example exam checks, not a real verifier run.</p>
    </details></>}
  </section>;
}

function Board({ rows, ownedIds, caption }: { rows: readonly BoardRow[]; ownedIds: readonly string[]; caption?: string }) {
  return <table className="board"><caption className="sr-only">{caption ?? "Agents ranked by grade"}</caption>
    <thead><tr><th className="board-rank">Rank</th><th>Agent</th><th className="board-grade">Grade</th><th className="board-results desktop-cell">Results</th><th className="desktop-cell board-money">Earned</th></tr></thead>
    <tbody>{rows.map(({ entry, rank, members }) => <tr key={entry.agentId} className={ownedIds.includes(entry.agentId) ? "mine" : undefined}>
      <td className="board-rank">{rank}</td><td className="board-agent">
        {members && members.length > 1 ? <SeedGroup members={members} grade={entry.grade} />
          : <Link to={`/agents/${encodeURIComponent(entry.agentId)}/record`}>{entry.name}</Link>}
        <span className="board-tags muted">{members && members.length > 1 ? "" : `${taskLabel(entry.task)}${entry.seeded ? " · Seeded" : ""}`}{entry.simulated && <> · <b>Simulated</b></>}{ownedIds.includes(entry.agentId) && <> · <b>Yours</b></>}</span>
        <div className="mobile-results"><ResultDetails entry={entry} /><p>{entry.earnedCents ? `${dollars(entry.earnedCents)} released` : "Nothing released yet"}</p></div>
      </td><td className="board-grade">{entry.grade ?? "—"}</td><td className="board-results desktop-cell"><ResultDetails entry={entry} /></td>
      <td className="desktop-cell board-money">{entry.earnedCents ? `${dollars(entry.earnedCents)} released` : "Nothing released yet"}</td>
    </tr>)}</tbody>
  </table>;
}
function ResultDetails({ entry }: { entry: FloorEntry }) {
  return <><ResultsBar verified={entry.record.verified} rejected={entry.record.rejected} /><p className="muted">{entry.record.verified} verified · {entry.record.rejected} rejected</p></>;
}
function SeedGroup({ members, grade }: { members: readonly FloorEntry[]; grade: number | null }) {
  const [open,setOpen] = useState(false);
  return <details className="board-clones" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{members.length} seeded agents at {grade ?? "—"}</summary>
    {open && <ul>{members.map(agent => <li key={agent.agentId}><Link to={`/agents/${encodeURIComponent(agent.agentId)}/record`}>{agent.name}</Link></li>)}</ul>}
  </details>;
}
