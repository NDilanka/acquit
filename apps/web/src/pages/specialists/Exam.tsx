import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../../api.ts";
import { Icon } from "../../icons.tsx";
import { Link } from "../../router.tsx";
import { EmptyState, ErrorNote, SkeletonCard, Spinner } from "../../ui.tsx";
import { AgentCard } from "./AgentCard.tsx";
import { loadExamReplay, specialists } from "./client.ts";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { Exam, ExamStatus, SpecialistAgent, Task } from "./types.ts";
import { useLoad } from "./useLoad.ts";
import {
  EXAM_SHAPE,
  SIMULATED_WORD,
  START_GRADE,
  checkLabel,
  examStartWords,
  examStatusWords,
  flagsFrom,
  gradeWords,
  isOpenExam,
  liveRunBlock,
  reasonSentences,
  replayLabel,
} from "./view.ts";

/** How fast a replay or a finished live run reveals its checks. */
const TICK_MS = 600;
/** How often a live run is read while it is open. */
const POLL_MS = 1000;

export function ExamPage({ agentId }: { readonly agentId?: string }) {
  return (
    <SpecialistPage
      step={2}
      agentId={agentId}
      lead="Visible checks tick off one by one. Hidden checks stay sealed until they open, and show only pass or fail."
    >
      <ExamBody agentId={agentId} />
    </SpecialistPage>
  );
}

function ExamBody({ agentId }: { readonly agentId?: string }) {
  const agents = useLoad(() => specialists.agents(), "agents");
  if (agents.data === null) {
    return agents.error !== null ? (
      <LoadFailed error={agents.error} onRetry={agents.reload} />
    ) : (
      <SkeletonCard lines={4} />
    );
  }
  const agent = agents.data.find((a) => a.id === agentId) ?? agents.data[0] ?? null;
  if (agent === null) {
    return (
      <EmptyState action={{ to: "/specialists", label: "Plug in an agent" }}>
        No agent to examine yet. Plug one in first.
      </EmptyState>
    );
  }
  return <ExamForAgent key={agent.id} agent={agent} onChanged={agents.reload} />;
}

function ExamForAgent({ agent, onChanged }: { readonly agent: SpecialistAgent; readonly onChanged: () => void }) {
  // The replay is read per task. A missing file comes back as null, not as an error.
  const replay = useLoad(async () => ({ replay: await loadExamReplay(agent.task) }), agent.task);
  const [exam, setExam] = useState<Exam | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  // The code the last start call answered with. A 503 that means live runs are not set up turns into the block reason.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pollError, setPollError] = useState<unknown>(null);
  const [pollTick, setPollTick] = useState(0);
  const [playId, setPlayId] = useState(0);

  const live = exam !== null;
  const open = exam !== null && isOpenExam(exam.status);

  // Read the live run once a second while it is open. Each read sets a new `exam`, which schedules the next read.
  useEffect(() => {
    if (exam === null || !isOpenExam(exam.status)) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      specialists.exam(agent.id, exam.id).then(
        (read) => {
          if (stopped) return;
          // A run that was just started is there to read. Null means it is gone, so polling stops with a message.
          if (read === null) {
            setPollError(new ApiError(404, "EXAM_NOT_FOUND"));
            return;
          }
          setExam(read.exam);
          if (!isOpenExam(read.exam.status)) onChanged();
        },
        (e: unknown) => {
          if (!stopped) setPollError(e);
        },
      );
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [agent.id, exam, pollTick, onChanged]);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    setPollError(null);
    try {
      setExam(await specialists.startExam(agent.id));
      setRefusal(null);
    } catch (e) {
      setRefusal(e instanceof ApiError ? e.code : null);
      setStartError(e);
    } finally {
      setStarting(false);
    }
  };

  const block = liveRunBlock(agent.task, agent.acquitted, refusal);
  const sample = replay.data?.replay ?? null;
  const shape = EXAM_SHAPE[agent.task];

  let board: { visible: readonly boolean[]; hidden: readonly boolean[]; ready: boolean; verdict: ReactNode } | null = null;
  if (exam === null && sample !== null) {
    board = {
      visible: sample.visible,
      hidden: sample.hidden,
      ready: true,
      verdict: (
        <VerdictLine
          status={sample.outcome}
          gradeText={`Starts at grade ${START_GRADE}`}
          reasons={sample.reasons}
          simulated={sample.simulated}
          recorded
        />
      ),
    };
  } else if (exam !== null && open) {
    board = {
      visible: Array.from({ length: shape.visible }, () => false),
      hidden: Array.from({ length: shape.hidden }, () => false),
      ready: false,
      verdict: null,
    };
  } else if (exam !== null) {
    board = {
      visible: exam.visible ? flagsFrom(exam.visible) : [],
      hidden: exam.hidden ? flagsFrom(exam.hidden) : [],
      ready: true,
      verdict: (
        <VerdictLine
          status={exam.status}
          gradeText={agent.acquitted ? gradeWords(agent.grade) : null}
          reasons={exam.reasons}
          simulated={exam.simulated}
        />
      ),
    };
  }

  const startMessage = startError instanceof ApiError ? examStartWords(startError.code) : null;
  const runDisabled = block !== null || starting || open;

  return (
    <>
      <AgentCard agent={agent} />

      <section className="card pad spec-exam" aria-labelledby="spec-exam-title">
        <div className="spec-exam-head">
          <h2 id="spec-exam-title" className="spec-h2">
            {live ? "Live run" : "Replay"}
          </h2>
          {!live && sample !== null && <span className="sandbox">{replayLabel(replay.data?.replay?.source ?? "fixture")}</span>}
        </div>

        {live && <p className="spec-status" role="status">{examStatusWords(exam.status)}{open && <Spinner />}</p>}

        {board !== null ? (
          <ChecksBoard
            key={live ? `live-${exam.id}` : `replay-${playId}`}
            task={agent.task}
            visible={board.visible}
            hidden={board.hidden}
            ready={board.ready}
            verdict={board.verdict}
          />
        ) : replay.data === null && replay.error !== null ? (
          <LoadFailed error={replay.error} onRetry={replay.reload} />
        ) : replay.data === null ? (
          <SkeletonCard lines={3} />
        ) : (
          <p className="muted">No replay is recorded for this task yet.</p>
        )}

        {pollError !== null && (
          <LoadFailed
            error={pollError}
            onRetry={() => {
              setPollError(null);
              setPollTick((n) => n + 1);
            }}
          />
        )}
        {startError !== null && startMessage === null && <ErrorNote error={startError} />}

        <div className="spec-actions">
          <button type="button" className="btn" disabled={runDisabled} onClick={() => void start()}>
            {starting && <Spinner />}
            {open ? "Running" : starting ? "Starting" : "Run it live"}
          </button>
          {block !== null && <p className="muted">{block}</p>}
          {live && !open && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setExam(null);
                setPlayId((n) => n + 1);
              }}
            >
              Show the replay
            </button>
          )}
          {!live && sample !== null && (
            <button type="button" className="btn secondary sm" onClick={() => setPlayId((n) => n + 1)}>
              Play again
            </button>
          )}
        </div>
      </section>

      <div className="spec-next">
        <Link to={`/specialists/orders/${agent.id}`} className="btn">
          Next
        </Link>
      </div>
    </>
  );
}

/**
 * The checks as a board. Each check reveals on its own tick. A visible check shows its mark, a hidden one stays sealed
 * until its tick, then opens to pass or fail only. The verdict appears after the last check.
 */
function ChecksBoard({
  task,
  visible,
  hidden,
  ready,
  verdict,
}: {
  readonly task: Task;
  readonly visible: readonly boolean[];
  readonly hidden: readonly boolean[];
  readonly ready: boolean;
  readonly verdict: ReactNode;
}) {
  const total = visible.length + hidden.length;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!ready || shown >= total) return;
    const timer = window.setTimeout(() => setShown((n) => n + 1), TICK_MS);
    return () => window.clearTimeout(timer);
  }, [ready, shown, total]);

  const done = ready && shown >= total;

  return (
    <div className="spec-board">
      <ol className="spec-checks" aria-label="Visible checks">
        {visible.map((passed, i) => {
          const state = i < shown ? (passed ? "passed" : "failed") : ready && i === shown ? "checking" : "waiting";
          return (
            <li key={i} className={`spec-check ${state}`}>
              <span className="spec-check-name">{checkLabel(task, i + 1)}</span>
              <span className="spec-check-state">
                {state === "passed" && (
                  <>
                    <Icon name="check" size={14} /> Passed
                  </>
                )}
                {state === "failed" && (
                  <>
                    <Icon name="close" size={14} /> Failed
                  </>
                )}
                {state === "checking" && (
                  <>
                    <Spinner /> Checking
                  </>
                )}
                {state === "waiting" && "Waiting"}
              </span>
            </li>
          );
        })}
      </ol>

      {hidden.length > 0 && (
        <ol className="spec-checks spec-sealed" aria-label="Hidden checks">
          {hidden.map((passed, j) => {
            const k = visible.length + j;
            const opened = k < shown;
            return (
              <li key={j} className={`spec-check ${opened ? (passed ? "passed" : "failed") : "sealed"}`}>
                <span className="spec-check-name">Hidden check {j + 1}</span>
                <span className="spec-check-state">
                  {opened ? (
                    passed ? (
                      <>
                        <Icon name="check" size={14} /> Opened: passed
                      </>
                    ) : (
                      <>
                        <Icon name="close" size={14} /> Opened: failed
                      </>
                    )
                  ) : (
                    <>
                      <Icon name="shield" size={14} /> Sealed
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {done && (
        <div className="spec-verdict" role="status">
          {verdict}
        </div>
      )}
    </div>
  );
}

/**
 * The verdict of a run. A replay's verdict is the recorded run's, so it says so; it is not this agent's status.
 * A simulated run carries the Simulated label whatever its outcome.
 */
function VerdictLine({
  status,
  gradeText,
  reasons,
  simulated,
  recorded = false,
}: {
  readonly status: ExamStatus;
  readonly gradeText: string | null;
  readonly reasons: readonly string[];
  readonly simulated: boolean;
  readonly recorded?: boolean;
}) {
  if (status === "PASSED") {
    return (
      <p className="spec-verdict-line">
        {recorded && <span className="muted">In the recorded run:</span>}
        <span className="pill ok">{examStatusWords(status)}</span>
        {simulated && <span className="sandbox">{SIMULATED_WORD}</span>}
        {gradeText && <span className="spec-grade">{gradeText}</span>}
      </p>
    );
  }
  return (
    <div className="spec-verdict-line">
      {recorded && <span className="muted">In the recorded run:</span>}
      <span className="pill new">{examStatusWords(status)}</span>
      {simulated && <span className="sandbox">{SIMULATED_WORD}</span>}
      {reasonSentences(reasons).length > 0 && (
        <ul className="spec-reasons">
          {reasonSentences(reasons).map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
