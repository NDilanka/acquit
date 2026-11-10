import { useEffect, useState } from "react";
import { ApiError } from "../../api";
import { Link, useRouter } from "../../router";
import { ErrorNote, SkeletonCard, Spinner } from "../../ui";
import { loadExamReplay, specialists } from "./client";
import { useOwner } from "./OwnerPanel";
import { ExamRecord } from "./ExamRecord";
import { LoadFailed, SpecialistPage } from "./SpecialistPage";
import type { Exam, SpecialistAgent } from "./types";
import { useLoad } from "./useLoad";
import { EXAM_SHAPE, hasLiveExam, isOpenExam, liveRunBlock, provenanceWords, localTime } from "./view";

export function ExamPage({ agentId }: { agentId?: string }) {
  const owner = useOwner();
  const { location } = useRouter();
  return <SpecialistPage step={2} agentId={agentId} lead="">
    {owner.agent && <ExamForAgent key={`${owner.agent.id}:${location.search.get("exam") ?? ""}`} agent={owner.agent} />}
  </SpecialistPage>;
}

function ExamForAgent({ agent }: { agent: SpecialistAgent }) {
  const { location } = useRouter();
  const { reload, setProvenance } = useOwner();
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
  }, [agent.id, examId, readTick]);
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
  const provenance = !available ? "Exam coming" : recordLoading ? "Reading exam record" : recordError ? "Record unavailable"
    : exam ? provenanceWords(null, exam.simulated) || "Live run" : sample ? provenanceWords(sample.source, sample.simulated) : "";
  useEffect(() => { setProvenance(provenance); return () => setProvenance(""); }, [provenance, setProvenance]);
  const start = async () => {
    if (!available || recordLoading || starting || liveRunBlock(agent.task, agent.acquitted, refusal) !== null) return;
    setStarting(true); setError(null);
    try { const next = await specialists.startExam(agent.id); setExam(next); setRefusal(null); if (!isOpenExam(next.status)) reload(); }
    catch (e) { setError(e); setRefusal(e instanceof ApiError ? e.code : null); }
    finally { setStarting(false); }
  };
  const status = exam?.status ?? sample?.outcome ?? "RUNNING";
  const open = exam !== null && isOpenExam(status);
  const block = liveRunBlock(agent.task, agent.acquitted, refusal);
  const date = exam !== null ? exam.endedAt : sample?.recordedAt ?? sample?.endedAt ?? null;
  const pass = status === "PASSED";
  const visible = exam !== null ? exam.visible : sample ? { total: sample.visible.length, passed: sample.visible.filter(Boolean).length } : null;
  const hidden = exam !== null ? exam.hidden : sample ? { total: sample.hidden.length, passed: sample.hidden.filter(Boolean).length } : null;
  const recordPath = `/specialists/exam/${encodeURIComponent(agent.id)}${exam ? `?exam=${encodeURIComponent(exam.id)}` : ""}`;
  if (!available) return <section className="exam-empty"><h1>Exam coming</h1>
    <p>The {agent.task === "print-fdm" ? "3D print" : "laser cut"} exam is not available in this build. No exam result is shown.</p>
    <div className="owner-actions"><Link to="/specialists" className="btn secondary">Choose another task</Link></div></section>;
  if (recordLoading) return <section><h1>Reading the exam record</h1><SkeletonCard lines={5} /></section>;
  if (recordError !== null) return <section><h1>Exam record unavailable</h1><LoadFailed error={recordError} onRetry={() => setReadTick((n) => n + 1)} primary /></section>;
  if (!exam && agent.acquitted) return <section className="exam-empty"><h1>No stored exam record</h1>
    <p>This agent is Acquitted, but no stored exam run is available. Sample data is not its exam record.</p>
    <div className="owner-actions"><Link to={`/specialists/orders/${encodeURIComponent(agent.id)}`} className="btn">Set standing orders</Link></div></section>;
  if (!exam && !sample && replay.error !== null) return <section><h1>Exam unavailable</h1><LoadFailed error={replay.error} onRetry={replay.reload} primary /></section>;
  if (!exam && !sample && replay.data === null) return <section><h1>Reading the sample exam</h1><SkeletonCard lines={5} /></section>;
  if (!exam && !sample) return <section className="exam-empty"><h1>Take the exam</h1><p>No recorded exam is available. Run it to make a record.</p>
    {error !== null && <ErrorNote error={error} />}<div className="owner-actions"><button type="button" className="btn" disabled={starting || block !== null} onClick={() => void start()}>{starting ? "Starting…" : "Take the exam"}</button></div>{block && <p>{block}</p>}</section>;
  return <>
    <ExamRecord status={status} simulated={exam?.simulated ?? sample?.simulated ?? false} task={agent.task} grade={exam ? agent.grade : null} date={date}
      visible={open ? null : visible} hidden={open ? null : hidden} shape={EXAM_SHAPE[agent.task]}
      recordPath={recordPath} provenance={<>
        {exam ? exam.simulated ? "Simulated" : "Live run" : sample?.source === "recorded"
          ? <>Replay of a recorded run{date && <> · <time dateTime={date} title={date}>{localTime(date)}</time></>}</>
          : "Sample data · not live"}
        {!exam && sample?.simulated && " · Simulated"}
        {!exam && <button type="button" className="text-button" disabled={starting || block !== null} onClick={() => void start()}>Run it live</button>}
      </>} />
    {error !== null && <LoadFailed error={error} onRetry={() => { setError(null); setPollTick((n) => n + 1); }} />}
    {block && !agent.acquitted && <p className="muted">{block}</p>}
    {!sample && !exam && <p>No recorded exam is available. Run the exam to make a record.</p>}
    {replay.error !== null && <ErrorNote error={replay.error} />}
    <div className="owner-actions">
      {pass && agent.acquitted ? <Link to={`/specialists/orders/${agent.id}`} className="btn">Set standing orders</Link>
        : <button className="btn" type="button" disabled={starting || open || block !== null} onClick={() => void start()}>
          {starting && <Spinner />}{open ? "Running the exam" : starting ? "Starting…" : status === "FAILED" || status === "ERROR" ? "Retry the exam" : "Take the exam"}
        </button>}
      {!pass && !open && <p>Bidding stays off.</p>}
    </div>
  </>;
}
