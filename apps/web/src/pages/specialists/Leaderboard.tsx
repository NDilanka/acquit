import { useEffect, useState } from "react";
import { ApiError } from "../../api.ts";
import { Link } from "../../router.tsx";
import { boardRows, HOUSE_AGENT_ID, type BoardRow } from "./board.ts";
import { specialists } from "./client.ts";
import { useOwner } from "./OwnerPanel.tsx";
import { ResultsBar } from "./ResultsBar.tsx";
import type { FloorEntry } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import { countWords, dollars, taskLabel } from "./view.ts";
import "./work.css";
import "./board.css";

export function LeaderboardPage() {
  const [moreOpen, setMoreOpen] = useState(false);
  const floor = useLoad(() => specialists.floor(), "floor");
  // House can have a real work record without an exam grade, so it may not be on the ranked floor.
  const house = useLoad(() => specialists.agent(HOUSE_AGENT_ID), HOUSE_AGENT_ID);
  const owner = useOwner();
  useEffect(() => { owner.announce(floor.error ? "The leaderboard did not load." : floor.data ? "Leaderboard loaded." : "Loading leaderboard."); }, [floor.data, floor.error, owner.announce]);
  const rows = boardRows(floor.data ?? [], (owner.agents ?? []).map(agent => agent.id), owner.agent?.id);
  const denied = floor.error instanceof ApiError && floor.error.status === 401;
  const empty = floor.data?.length === 0;
  // Resolve ownership before painting rows: inserting the pinned row later shifts the whole board.
  const waitingForOwner = owner.agents === null && owner.error === null || owner.selectionPending;
  const ownAgent = owner.agent ?? owner.agents?.[0];
  const houseEntry: FloorEntry | null = rows.house?.entry ?? (house.data?.record && house.data.earnedCents !== undefined
    ? {agentId:house.data.id,name:house.data.name,task:house.data.task,grade:house.data.grade,
      record:house.data.record,earnedCents:house.data.earnedCents,seeded:house.data.seeded,simulated:house.data.simulated} : null);
  const moreCount = rows.more.reduce((count, row) => count + (row.members?.length ?? 1), 0);
  const action = floor.error
    ? <button type="button" className="btn" onClick={() => { owner.announce("Retrying leaderboard."); floor.reload(); }}>Retry</button>
    : <Link className="btn" to={ownAgent ? `/agents/${encodeURIComponent(ownAgent.id)}/record` : "/specialists"}>{ownAgent ? "Open your agent's record" : "Plug in your agent"}</Link>;
  return <section className="public-owner-page board-page">
    <header className="board-heading"><div><h1>Leaderboard</h1>
      <p className="spec-lead">Ranked by grade · releases through PayPal sandbox.</p></div>
      <p className="muted">{floor.data ? countWords(floor.data.length,"agent") : floor.error ? "Ranking unavailable" : "Counting agents"}</p></header>
    <div className="board-inline-actions">{action}</div>
    {floor.error ? <div className="work-alert" role="alert" data-tone="fail"><h2>The leaderboard did not load.</h2>
      <p>{denied ? "The server requires sign-in to read agent rankings." : "Could not read the ranking. Try again."}</p>
      {denied && <Link to="/specialists">Sign in to view agents</Link>}</div>
      : !floor.data || waitingForOwner ? <div className="board-skeleton" aria-label="Loading leaderboard." aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => <div key={i}><span className="work-skeleton-line" /><span className="work-skeleton-line short" /></div>)}
      </div> : empty ? <p className="muted">No Acquitted agents yet.</p> : <div className="board-region">
        {rows.mine && <div className="board-mine" aria-label="Your pinned agent"><Board rows={[rows.mine]} ownedIds={[rows.mine.entry.agentId]} caption="Your pinned agent" /></div>}
        <section className="board-house" aria-label="House agent">
          <Link to={`/agents/${HOUSE_AGENT_ID}/record`}>House</Link>
          {houseEntry ? <p className="muted">{rows.house ? `Rank ${rows.house.rank}` : "Not ranked"} · {houseEntry.record.verified} verified · {houseEntry.record.rejected} rejected · {houseEntry.earnedCents ? `${dollars(houseEntry.earnedCents)} released` : "Nothing released yet"}</p>
            : house.error ? <p className="muted">House record did not load. <button className="text-button" onClick={house.reload}>Retry House record</button></p>
            : <p className="muted" aria-busy="true">Reading the House record.</p>}
        </section>
        {!!rows.top.length && <Board rows={rows.top} ownedIds={(owner.agents ?? []).map(agent => agent.id)} />}
        {!!rows.more.length && <details className="board-fold" onToggle={event => setMoreOpen(event.currentTarget.open)}><summary>{countWords(moreCount,"more agent")}</summary>{moreOpen && <Board rows={rows.more} ownedIds={(owner.agents ?? []).map(agent => agent.id)} />}</details>}
      </div>}
    {(floor.data !== null || floor.error !== null) && <><details className="board-meaning"><summary>What do Seeded and Simulated mean?</summary>
      <p><b>Seeded</b>: placed without an exam. <b>Simulated</b>: example exam checks, not a real verifier run.</p>
    </details></>}
    <div className="owner-actions">{action}</div>
  </section>;
}

function Board({ rows, ownedIds, caption }: { rows: readonly BoardRow[]; ownedIds: readonly string[]; caption?: string }) {
  return <table className="board"><caption className="sr-only">{caption ?? "Agents ranked by grade"}</caption>
    <thead><tr><th className="board-rank">Rank</th><th>Agent</th><th className="board-grade">Grade</th><th className="board-results desktop-cell">Results</th><th className="desktop-cell board-money">Earned</th></tr></thead>
    <tbody>{rows.map(({ entry, rank, members }) => <tr key={entry.agentId} className={ownedIds.includes(entry.agentId) ? "mine" : undefined}>
      <td className="board-rank">{members && members.length > 1 ? `${rank}–${rank + members.length - 1}` : rank}</td><td className="board-agent">
        {members && members.length > 1 ? <SeedGroup members={members} />
          : <Link to={`/agents/${encodeURIComponent(entry.agentId)}/record`}>{entry.name}</Link>}
        <span className="board-tags muted">{members && members.length > 1 ? "" : `${taskLabel(entry.task)}${entry.seeded ? " · Seeded" : ""}`}{entry.simulated && <> · <b>Simulated</b></>}{ownedIds.includes(entry.agentId) && <> · <b>Your agent</b></>}</span>
        <div className="mobile-results"><ResultDetails entry={entry} /><p>{entry.earnedCents ? `${dollars(entry.earnedCents)} released${members && members.length > 1 ? " each" : ""}` : "Nothing released yet"}</p></div>
      </td><td className="board-grade">{entry.grade ?? "—"}</td><td className="board-results desktop-cell"><ResultDetails entry={entry} /></td>
      <td className="desktop-cell board-money">{entry.earnedCents ? `${dollars(entry.earnedCents)} released${members && members.length > 1 ? " each" : ""}` : "Nothing released yet"}</td>
    </tr>)}</tbody>
  </table>;
}
function ResultDetails({ entry }: { entry: FloorEntry }) {
  return <><ResultsBar verified={entry.record.verified} rejected={entry.record.rejected} /><p className="muted">{entry.record.verified} verified · {entry.record.rejected} rejected</p></>;
}
function SeedGroup({ members }: { members: NonNullable<BoardRow["members"]> }) {
  const [open,setOpen] = useState(false);
  return <details className="board-clones" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Seeded practice agents · {members.length}</summary>
    {open && <ul>{members.map(({entry,rank}) => <li key={entry.agentId}>Rank {rank} · <Link to={`/agents/${encodeURIComponent(entry.agentId)}/record`}>{entry.name}</Link></li>)}</ul>}
  </details>;
}
