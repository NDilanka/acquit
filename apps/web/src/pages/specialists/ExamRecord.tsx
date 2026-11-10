import { useState, type ReactNode } from "react";
import { Link } from "../../router";
import type { Counts, ExamStatus, Task } from "./types";
import { localTime, taskLabel, isOpenExam } from "./view";

export function Envelope({ opened, failed = false }: { opened: boolean; failed?: boolean }) {
  return <svg className={`record-envelope ${opened ? "open" : "sealed"}`} viewBox="0 0 24 28" aria-hidden="true">
    <rect x="1" y="9" width="22" height="16" rx="2" />
    <path className="envelope-mark" d={failed ? "M8 14l8 7m0-7-8 7" : "m7 18 3 3 7-7"} />
    <path className="envelope-flap" d="M2 10 12 17 22 10Z" />
  </svg>;
}

export function Seal({ passed }: { passed: boolean }) {
  return <svg className={`record-seal ${passed ? "stamp" : "empty"}`} viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="30" /><circle className="seal-dashes" cx="32" cy="32" r="26" />
    <circle className="seal-core" cx="32" cy="32" r="20" />
    {passed && <path className="seal-tick" d="m23 33 6 6 12-13" />}
  </svg>;
}

/** Aggregate, anonymous results only: API counts do not identify individual tests. */
export function CheckCells({ counts, total, hidden }: { counts: Counts | null; total: number; hidden: boolean }) {
  const failed = counts ? counts.total - counts.passed : 0;
  return <section className={`record-check-group ${hidden ? "hidden-group" : ""}`} aria-label={hidden ? "Hidden checks" : "Visible checks"}>
    <p className="check-group-label">{hidden ? "Hidden checks" : "Visible checks"}{counts && <span>{counts.passed} / {counts.total} passed</span>}</p>
    <ol className="record-cells" style={{ gridTemplateColumns: `repeat(${Math.max(total, 1)}, minmax(0, 1fr))` }}>
      {Array.from({ length: total }, (_, i) => {
        const fail = !!counts && i >= total - failed;
        const state = counts ? fail ? "Failed" : "Passed" : hidden ? "Sealed" : "Waiting";
        return <li key={i} className="record-check-cell" data-tone={fail ? "fail" : undefined}>
          {hidden ? <Envelope opened={counts !== null} failed={fail} /> : <span className="check-symbol" aria-hidden="true">{counts ? fail ? "×" : "✓" : "—"}</span>}
          <span>{state}</span>
        </li>;
      })}
    </ol>
  </section>;
}

/** Reusable proof object. No hidden test identifiers or reason payloads enter the DOM. */
export function ExamRecord({ status, task, grade, date, visible, hidden, shape, recordPath, provenance }: {
  status: ExamStatus; task: Task; grade: number | null; date: string | null;
  visible: Counts | null; hidden: Counts | null; shape: { visible: number; hidden: number };
  recordPath: string; provenance: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const passed = status === "PASSED";
  const open = isOpenExam(status);
  const copy = async () => {
    try { await navigator.clipboard.writeText(new URL(recordPath, window.location.origin).href); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  };
  return <section className="exam-record" aria-label="Exam record">
    <header className="record-heading" aria-live="polite">
      <Seal passed={passed} />
      <div><h1 className={passed ? "record-key" : ""}>{passed ? "Acquitted" : open ? "Exam in progress" : status === "ERROR" ? "Exam interrupted" : "Not acquitted"}</h1>
        <div className="record-origin">{provenance}</div>
      </div>
    </header>
    <div className="record-meta"><span>{taskLabel(task)}</span>{grade !== null && <span>Grade {grade}</span>}
      {date && <time dateTime={date} title={date}>{localTime(date)}</time>}</div>
    <p className="record-running" role="status">{open ? "Running. Results arrive together, not as live progress." : "Aggregate results · identities stay private."}</p>
    <div className="record-check-bed">
      <CheckCells counts={visible} total={visible?.total ?? shape.visible} hidden={false} />
      <CheckCells counts={hidden} total={hidden?.total ?? shape.hidden} hidden />
    </div>
    <div className="record-foot">
      <details><summary>Why hidden checks?</summary><p>The agent never sees these tests. Only pass or fail is shown.</p></details>
      {!open && <div className="record-ref" data-chunked><Link to={recordPath}>Record link</Link>
        <button type="button" className="text-button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button></div>}
    </div>
    {copyError && <p role="status">Copy failed. Open Record link and copy the address.</p>}
  </section>;
}
