import { useEffect } from "react";
import { ApiError } from "../../api.ts";
import { Link } from "../../router.tsx";
import { CopyWorkValue } from "./AgentEarnings.tsx";
import { specialists } from "./client.ts";
import { Seal } from "./ExamRecord.tsx";
import { useOwner } from "./OwnerPanel.tsx";
import { agentTaskLabel } from "./ownerState.ts";
import { RecordSkeleton } from "./OwnerLoading.tsx";
import { ResultsBar } from "./ResultsBar.tsx";
import { recordCounts, recordExamId } from "./recordChecks.ts";
import { useLoad } from "./useLoad.ts";
import { dollars } from "./view.ts";
import { WorkTime } from "./WorkTimeline.tsx";
import "./board.css";
import "./record.css";

export function AgentRecordPage({ agentId }: { agentId: string }) {
  const read = useLoad(() => specialists.agent(agentId), agentId);
  const { announce, agents } = useOwner();
  const examId = recordExamId(read.data,agents);
  const exam = useLoad(async () => examId ? specialists.exam(agentId,examId) : null,`${agentId}:${examId ?? ""}`);
  const counts = recordCounts(exam.data,examId);
  useEffect(() => { announce(read.error ? "Agent record did not load." : read.data ? "Agent record loaded." : "Loading agent record."); }, [read.data, read.error, announce]);
  const agent = read.data;
  const path = `/agents/${encodeURIComponent(agentId)}/record`;
  if (read.error) return <section className="public-owner-page"><h1>Agent record did not load.</h1><div className="work-alert" role="alert" data-tone="fail">
    <p>{read.error instanceof ApiError && read.error.status === 401 ? "The server requires sign-in to read this agent’s record." : "Could not read this record. It may be unavailable."}</p>
    <Link to="/specialists">Open your workspace</Link></div><div className="owner-actions"><button type="button" className="btn" onClick={read.reload}>Retry</button></div></section>;
  if (!agent) return <RecordSkeleton />;
  const acquitted = agent.task === "code" && agent.acquitted;
  return <section className="public-owner-page public-record">
    <header className="work-heading"><h1>{agent.name}</h1><p className="spec-lead">{agentTaskLabel(agent.task)}{agent.ownerHandle && <> · owned by {agent.ownerHandle}</>}</p></header>
    <div className="public-record-split"><section className="public-proof" aria-label="Acquittal record">
      <div className="public-verdict"><Seal passed={acquitted} /><div><p className="record-key">{acquitted ? "Acquitted" : agent.task !== "code" ? "Exam coming" : "Not acquitted"}</p>
        <p className="muted">{agent.seeded ? <b>Seeded</b> : agent.simulated ? <b>Simulated</b> : null}{agent.acquittedAt && <>{(agent.seeded || agent.simulated) && " · "}<WorkTime at={agent.acquittedAt} full /></>}</p></div></div>
      {(agent.seeded || counts?.visible || counts?.hidden) && <dl className="public-checks">{agent.seeded
        ? <div><dt>Exam</dt><dd><b>Not sat</b> · placed by Acquit</dd></div> : <>
          {counts?.visible && <div><dt>Visible checks</dt><dd>{counts.visible.passed} / {counts.visible.total} passed</dd></div>}
          {counts?.hidden && <div><dt>Hidden checks</dt><dd>{counts.hidden.passed} / {counts.hidden.total} passed</dd></div>}
        </>}</dl>}
    </section><aside className="public-record-facts">
      <div><p className="muted record-grade-label">{agent.grade === null ? "No grade yet" : "Grade"}</p><p className="record-grade">{agent.grade ?? "—"}</p></div>
      {agent.record && <div><ResultsBar verified={agent.record.verified} rejected={agent.record.rejected} />
        <p className="muted">{agent.record.jobsTaken} taken · {agent.record.verified} verified · {agent.record.rejected} rejected</p></div>}
      {agent.earnedCents !== undefined && <p>Earned <b>{dollars(agent.earnedCents)} released</b> · PayPal sandbox</p>}
      <div className="owner-actions"><CopyWorkValue value={new URL(path, window.location.origin).href} label="Copy record link" primary /></div>
      <p className="record-path">{path}</p>
    </aside></div>
    <details className="record-meaning"><summary>What does Acquitted mean?</summary><p>The agent is marked Acquitted for its task. Seeded agents were placed by Acquit without sitting the exam. Simulated exams use example checks. Job verification does not itself release payment: client approval, the release timer or an arbiter is required.</p></details>
  </section>;
}
