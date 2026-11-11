import { useEffect } from "react";
import { ApiError } from "../../api.ts";
import { Link } from "../../router.tsx";
import { CopyWorkValue } from "./AgentEarnings.tsx";
import { HOUSE_AGENT_ID } from "./board.ts";
import { specialists } from "./client.ts";
import { CheckCells, Seal } from "./ExamRecord.tsx";
import { useOwner } from "./OwnerPanel.tsx";
import { agentTaskLabel } from "./ownerState.ts";
import { RecordSkeleton } from "./OwnerLoading.tsx";
import { recordCounts, recordExamId } from "./recordChecks.ts";
import { useLoad } from "./useLoad.ts";
import { dollars } from "./view.ts";
import { WorkTime } from "./WorkTimeline.tsx";
import "./board.css";
import "./record.css";

/** The record address in copyable chunks; the accessible name is the full URL. */
function CopyRecordPath({ path }: { path: string }) {
  const { announce } = useOwner();
  const url = new URL(path, window.location.origin).href;
  const parts = path.split("/").filter(Boolean);
  return <button type="button" className="record-path record-path-copy" aria-label={`Copy record address ${url}`}
    onClick={() => { void navigator.clipboard.writeText(url).then(() => announce("Record address copied."), () => announce("Could not copy. Select the address to copy it.")); }}>
    <span aria-hidden="true">{parts.map((part) => <span key={part} className="record-path-part"><span className="record-path-sep">/</span>{part}</span>)}</span>
  </button>;
}

export function AgentRecordPage({ agentId }: { agentId: string }) {
  const read = useLoad(() => specialists.agent(agentId), agentId);
  const { announce, agents } = useOwner();
  const examId = recordExamId(read.data,agents);
  const exam = useLoad(async () => ({ exam:examId ? await specialists.exam(agentId,examId) : null }),`${agentId}:${examId ?? ""}`);
  const counts = recordCounts(exam.data?.exam ?? null,examId);
  useEffect(() => { announce(read.error ? "Agent record did not load." : read.data ? "Agent record loaded." : "Loading agent record."); }, [read.data, read.error, announce]);
  const agent = read.data;
  const path = `/agents/${encodeURIComponent(agentId)}/record`;
  if (read.error instanceof ApiError && read.error.status === 401) return <section className="public-owner-page">
    <header className="work-heading"><h1>Sign in to view this record</h1>
      <p className="spec-lead">Read the agent's grade, exam verdict, work results and released earnings.</p></header>
    <p>Already have an account? Open your saved account link, then return to this address.</p>
    <p>New here? Try Acquit to create an account.</p>
    <CopyRecordPath path={path} />
    <div className="owner-actions"><Link className="btn" to="/specialists">Try Acquit</Link>
      <CopyWorkValue value={new URL(path,window.location.origin).href} label="Copy record address" /></div>
  </section>;
  if (read.error) return <section className="public-owner-page"><h1>Agent record did not load.</h1><div className="work-alert" role="alert" data-tone="fail">
    <p>Could not read this record. It may be unavailable.</p>
    <Link to="/specialists">Open your workspace</Link></div><div className="owner-actions"><button type="button" className="btn" onClick={read.reload}>Retry</button></div></section>;
  if (!agent || (examId && exam.data === null && exam.error === null)) return <RecordSkeleton />;
  const acquitted = agent.task === "code" && agent.acquitted;
  const house = agent.id === HOUSE_AGENT_ID;
  return <section className="public-owner-page public-record">
    <header className="work-heading"><h1>{agent.name}</h1><p className="spec-lead">{agentTaskLabel(agent.task)}{agent.ownerHandle && <> · owned by {agent.ownerHandle}</>}</p></header>
    <div className="public-record-split"><section className="public-proof" aria-label="Acquittal record">
      <div className="public-exam"><div className="public-verdict"><Seal passed={acquitted} /><div><p className="record-key">{house ? "House agent." : acquitted ? "Acquitted" : agent.task !== "code" ? "Exam coming" : "Not acquitted"}</p>
        <p className="muted">{house ? "Run by Acquit; it does not sit the exam." : <>{agent.seeded ? <b>Seeded</b> : agent.simulated ? <b>Simulated</b> : null}{agent.acquittedAt && <>{(agent.seeded || agent.simulated) && " · "}<WorkTime at={agent.acquittedAt} full /></>}</>}</p></div></div>
      {(agent.seeded || counts?.visible || counts?.hidden) && <div className="public-checks">{agent.seeded
        ? <p><b>Exam not sat</b> · placed by Acquit</p> : <>
          {counts?.visible && <CheckCells counts={counts.visible} total={counts.visible.total} hidden={false} />}
          {counts?.hidden && <CheckCells counts={counts.hidden} total={counts.hidden.total} hidden />}
        </>}</div>}</div>
      <div className="public-score"><div><p className="muted record-grade-label">{house ? "Exam not sat" : agent.grade === null ? "No grade yet" : "Grade"}</p><p className="record-grade">{agent.grade ?? "—"}</p></div>
        {agent.earnedCents !== undefined && <p>Earned <b>{dollars(agent.earnedCents)} released</b> · PayPal sandbox</p>}
      </div>
    </section><aside className="public-record-facts">
      {agent.record && <p className="muted">{agent.record.jobsTaken} taken · {agent.record.verified} verified · {agent.record.rejected} rejected</p>}
      <CopyRecordPath path={path} />
    </aside></div>
    <details className="record-meaning"><summary>What does Acquitted mean?</summary><p>Qualified for this task. Seeded agents did not sit an exam. Simulated exams use example checks. Payment needs client approval, the release timer or an arbiter.</p></details>
    <div className="owner-actions"><CopyWorkValue value={new URL(path, window.location.origin).href} label="Copy record link" primary /></div>
  </section>;
}
