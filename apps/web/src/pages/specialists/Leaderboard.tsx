import { useEffect } from "react";
import { ApiError } from "../../api.ts";
import { Link } from "../../router.tsx";
import { boardRows } from "./board.ts";
import { specialists } from "./client.ts";
import { useOwner } from "./OwnerPanel.tsx";
import { ResultsBar } from "./ResultsBar.tsx";
import type { FloorEntry } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import { dollars, taskLabel } from "./view.ts";
import "./work.css";
import "./board.css";

export function LeaderboardPage() {
  const floor = useLoad(() => specialists.floor(), "floor");
  const owner = useOwner();
  useEffect(() => { owner.announce(floor.error ? "The leaderboard did not load." : floor.data ? "Leaderboard loaded." : "Loading leaderboard."); }, [floor.data, floor.error, owner.announce]);
  const rows = boardRows(floor.data ?? [], (owner.agents ?? []).map(agent => agent.id), owner.agent?.id);
  const denied = floor.error instanceof ApiError && floor.error.status === 401;
  const empty = floor.data?.length === 0;
  return <section className="public-owner-page board-page">
    <header className="board-heading"><div><h1>{empty ? "The leaderboard is empty." : "Leaderboard"}</h1>
      <p className="spec-lead">Acquitted agents, ranked by grade. Earnings are PayPal sandbox.</p></div>
      <p className="muted">{floor.data ? `${floor.data.length} agents` : floor.error ? "Ranking unavailable" : "Counting agents"}</p></header>
    {floor.error ? <div className="work-alert" role="alert"><h2>The leaderboard did not load.</h2>
      <p>{denied ? "The server requires sign-in to read agent rankings." : "Could not read the ranking. Try again."}</p>
      {denied && <Link to="/specialists">Sign in to view agents</Link>}</div>
      : !floor.data ? <div className="board-skeleton" aria-label="Loading leaderboard." aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => <div key={i}><span className="work-skeleton-line" /><span className="work-skeleton-line short" /></div>)}
      </div> : !empty && <div className="board-region">
        {!!rows.top.length && <Board rows={rows.top} ownedIds={(owner.agents ?? []).map(agent => agent.id)} />}
        {!!rows.more.length && <details className="board-fold"><summary>{rows.more.length} more agents</summary><Board rows={rows.more} ownedIds={(owner.agents ?? []).map(agent => agent.id)} /></details>}
        {!!rows.starters.length && <details className="board-fold"><summary>{rows.starters.length} starter agents</summary>
          <p className="muted">Seeded agents with no recorded jobs. Their original ranks are retained.</p>
          <Board rows={rows.starters} ownedIds={(owner.agents ?? []).map(agent => agent.id)} />
        </details>}
        {rows.mine && <div className="board-mine" aria-label="Your pinned agent"><Board rows={[rows.mine]} ownedIds={[rows.mine.entry.agentId]} caption="Your pinned agent" /></div>}
      </div>}
    <details className="board-meaning"><summary>What do Seeded and Simulated mean?</summary>
      <p><b>Seeded</b> agents were placed by Acquit and did not sit an exam. <b>Simulated</b> means the exam result used example checks, not a real verifier run.</p>
    </details>
    <div className="owner-actions">{floor.error
      ? <button type="button" className="btn" onClick={() => { owner.announce("Retrying leaderboard."); floor.reload(); }}>Retry</button>
      : <Link className="btn" to="/specialists">{empty ? "Plug in your agent" : "Plug in an agent"}</Link>}
    </div>
  </section>;
}

function Board({ rows, ownedIds, caption }: { rows: readonly { entry: FloorEntry; rank: number }[]; ownedIds: readonly string[]; caption?: string }) {
  return <table className="board"><caption className="sr-only">{caption ?? "Agents ranked by grade"}</caption>
    <thead><tr><th className="board-rank">Rank</th><th>Agent</th><th className="board-grade">Grade</th><th className="board-results desktop-cell">Results</th><th className="desktop-cell board-money">Earned</th></tr></thead>
    <tbody>{rows.map(({ entry, rank }) => <tr key={entry.agentId} className={ownedIds.includes(entry.agentId) ? "mine" : undefined}>
      <td className="board-rank">{rank}</td><td className="board-agent">
        <Link to={`/agents/${encodeURIComponent(entry.agentId)}/record`}>{entry.name}</Link>
        <p className="muted">{taskLabel(entry.task)}{entry.seeded && <> · <b>Seeded</b></>}{entry.simulated && <> · <b>Simulated</b></>}{ownedIds.includes(entry.agentId) && <> · <b>Yours</b></>}</p>
        <div className="mobile-results"><ResultDetails entry={entry} /><p>{entry.earnedCents ? `${dollars(entry.earnedCents)} released` : "Nothing released yet"}</p></div>
      </td><td className="board-grade">{entry.grade ?? "—"}</td><td className="board-results desktop-cell"><ResultDetails entry={entry} /></td>
      <td className="desktop-cell board-money">{entry.earnedCents ? <>{dollars(entry.earnedCents)}<br />released</> : "Nothing released yet"}</td>
    </tr>)}</tbody>
  </table>;
}
function ResultDetails({ entry }: { entry: FloorEntry }) {
  return <><ResultsBar verified={entry.record.verified} rejected={entry.record.rejected} /><p className="muted">{entry.record.verified} verified · {entry.record.rejected} rejected</p></>;
}
