import { useEffect, useState } from "react";
import { ApiError } from "../../api";
import { Link, useRouter } from "../../router";
import { ErrorNote, SkeletonCard, Spinner } from "../../ui";
import { loadExamReplay, specialists } from "./client";
import { useOwner } from "./OwnerPanel";
import { CheckCells, ExamRecord } from "./ExamRecord";
import { LoadFailed, SpecialistPage } from "./SpecialistPage";
import type { Exam, SpecialistAgent } from "./types";
import { useLoad } from "./useLoad";
import { hasLiveExam, isOpenExam, liveRunBlock } from "./view";

export function ExamPage({ agentId }: { agentId?: string }) {
  const owner = useOwner();
  const { location } = useRouter();
  return <SpecialistPage step={2} agentId={agentId} lead="">
    {owner.agent && <ExamForAgent key={`${owner.agent.id}:${location.search.get("exam") ?? ""}`} agent={owner.agent} />}
  </SpecialistPage>;
}

function ExamForAgent({ agent }: { agent: SpecialistAgent }) {
  const { location } = useRouter();
  const { reload, announce } = useOwner();
  const available = hasLiveExam(agent.task);
  const replay = useLoad(async () => ({ replay: available ? await loadExamReplay(agent.task) : null }), agent.task);
  const examId = location.search.get("exam");
  const [exam, setExam] = useState<Exam | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pollTick, setPollTick] = useState(0);
  const [readTick, setReadTick] = useState(0);
  const [recordLoading, setRecordLoading] = useState(true);
  const [recordError, setRecordError] = useState<unknown>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (!available) { setRecordLoading(false); return; }
    let cancelled = false;
    setRecordLoading(true); setRecordError(null);
    specialists.exam(agent.id, examId ?? undefined).then((r) => {
      if (!cancelled) {
        setExam(r?.exam ?? null);
        if (!r && examId) setRecordError(new ApiError(404, "EXAM_NOT_FOUND"));
        setRecordLoading(false);
      }
    }, (e) => { if (!cancelled) { setRecordError(e); setRecordLoading(false); } });
    return () => { cancelled = true; };
  }, [agent.id, examId, readTick, available]);
  useEffect(() => {
    if (!exam || !isOpenExam(exam.status) || error) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      specialists.exam(agent.id, exam.id).then((r) => {
        if (cancelled) return;
        if (!r) { setError(new ApiError(404, "EXAM_NOT_FOUND")); return; }
        setExam(r.exam);
        if (!isOpenExam(r.exam.status)) reload();
      }, (e) => { if (!cancelled) setError(e); });
    }, 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [agent.id, exam, error, pollTick, reload]);
  // A fixture never stands in for an acquitted agent's missing server record.
  const sample = available && !agent.acquitted ? replay.data?.replay ?? null : null;
  const start = async () => {
    if (!available || recordLoading || starting || liveRunBlock(agent.task, agent.acquitted, refusal) !== null) return;
    setStarting(true); setError(null);
    try { const next = await specialists.startExam(agent.id); setExam(next); setRefusal(null); if (!isOpenExam(next.status)) reload(); }
    catch (e) { setError(e); setRefusal(e instanceof ApiError ? e.code : null); }
    finally { setStarting(false); }
  };
  const status = exam?.status ?? "RUNNING";
  const open = exam !== null && isOpenExam(status);
  const block = liveRunBlock(agent.task, agent.acquitted, refusal);
  const date = exam?.endedAt ?? null;
  const pass = exam?.status === "PASSED";
  useEffect(() => { announce(!available ? "Exam coming." : recordLoading ? "Loading exam record." : recordError ? "Exam record unavailable." : exam ? `Exam ${exam.status.toLowerCase()}.` : "Ready to take the exam."); }, [available, recordLoading, recordError, exam?.status, announce]);
  const recordPath = `/specialists/exam/${encodeURIComponent(agent.id)}${exam ? `?exam=${encodeURIComponent(exam.id)}` : ""}`;
  if (!available) return <section className="exam-empty"><h1>Simulated {agent.task === "print-fdm" ? "3D printer" : "laser cutter"} · Exam coming</h1>
    <p>This exam is not available in this build.</p></section>;
  if (recordLoading) return <section className="exam-record exam-loading" aria-busy="true"><h1>Reading the exam record</h1><SkeletonCard lines={5} /></section>;
  if (recordError !== null) return <section><h1>Exam record unavailable</h1><LoadFailed error={recordError} onRetry={() => setReadTick((n) => n + 1)} primary /></section>;
  if (!exam && agent.acquitted) return <section className="exam-empty"><h1>No stored exam record</h1>
    <p>This agent is Acquitted, but no stored exam run is available. Sample data is not its exam record.</p>
    <div className="owner-actions"><Link to={`/specialists/orders/${encodeURIComponent(agent.id)}`} className="btn">Set standing orders</Link></div></section>;
  if (!exam) return <section className="exam-before"><h1>Take the exam</h1><p>Pass to bid on code jobs.</p>
    {sample && <details className="exam-sample"><summary>Example of a passed exam · sample data</summary>
      <div className="sample-proof"><p>Example only, not your agent’s record.</p>
        <CheckCells counts={{ total: sample.visible.length, passed: sample.visible.filter(Boolean).length }} total={sample.visible.length} hidden={false} />
        <CheckCells counts={{ total: sample.hidden.length, passed: sample.hidden.filter(Boolean).length }} total={sample.hidden.length} hidden />
      </div>
    </details>}
    {error !== null && <ErrorNote error={error} />}
    <div className="owner-actions"><button type="button" className="btn" disabled={starting || block !== null} onClick={() => void start()}>{starting ? "Starting…" : "Take the exam"}</button></div>
    {block && <p>{block}</p>}</section>;
  const action = pass && agent.acquitted ? <Link to={`/specialists/orders/${encodeURIComponent(agent.id)}`} className="btn">Set standing orders</Link>
    : <button className="btn" type="button" disabled={starting || open || block !== null} onClick={() => void start()}>
      {starting && <Spinner />}{open ? "Running the exam" : starting ? "Starting…" : status === "FAILED" || status === "ERROR" ? "Retry the exam" : "Take the exam"}
    </button>;
  return <>
    <ExamRecord status={status} simulated={exam.simulated} task={agent.task} grade={agent.grade} date={date}
      visible={open ? null : exam.visible} hidden={open ? null : exam.hidden}
      recordPath={recordPath} action={action} />
    {error !== null && <LoadFailed error={error} onRetry={() => { setError(null); setPollTick((n) => n + 1); }} />}
    {block && !agent.acquitted && <p className="muted">{block}</p>}
  </>;
}
