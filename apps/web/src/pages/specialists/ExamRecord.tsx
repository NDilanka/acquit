import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "../../router";
import { useOwner } from "./OwnerPanel";
import type { Counts, ExamStatus, Task } from "./types";
import { checkLayout, localTime, taskLabel, isOpenExam, SIMULATED_WORD } from "./view";

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
  const layout = checkLayout(total, hidden);
  const rows: ReactNode[] = [];
  for (const indices of layout.rows) {
    rows.push(<ol key={indices[0]} className="record-cells" style={{ gridTemplateColumns: `repeat(${indices.length}, minmax(0, 1fr))` }}>
      {indices.map((i) => {
        const fail = !!counts && i >= total - failed;
        const state = counts ? fail ? "Failed" : "Passed" : hidden ? "Sealed" : "Waiting";
        return <li key={i} className="record-check-cell" data-tone={fail ? "fail" : undefined}>
          {hidden ? <Envelope opened={counts !== null} failed={fail} /> : <span className="check-symbol" aria-hidden="true">{counts ? fail ? "×" : "✓" : "—"}</span>}
          <span className={hidden ? "sr-only" : undefined}>{state}</span>
        </li>;
      })}
    </ol>);
  }
  return <section className={`record-check-group ${hidden ? "hidden-group" : ""}`} aria-label={hidden ? "Hidden checks" : "Visible checks"}>
    <p className="check-group-label">{hidden ? "Hidden checks" : "Visible checks"}{counts && <span>{counts.passed} / {counts.total} passed</span>}</p>
    {layout.segmented ? <div className="record-check-bar" role="img" aria-label={counts ? `${counts.passed} / ${counts.total} passed` : `${total} checks waiting`}
      style={{ "--segments": Math.min(total, 12), "--passed": `${counts && total ? counts.passed / total * 100 : 0}%`,
        "--bar-rest": counts && failed ? "var(--red)" : "var(--surface-2)" } as CSSProperties} />
      : <CheckRowGroups rows={rows} />}
  </section>;
}

/** Bound every visual group, including unusually large hidden-check counts. */
function CheckRowGroups({ rows }: { rows: ReactNode[] }): ReactNode {
  if (rows.length <= 7) return <div className="record-cell-rows">{rows}</div>;
  return <CheckRowGroups rows={Array.from({ length: Math.ceil(rows.length / 7) }, (_, i) =>
    <div key={i} className="record-cell-rows">{rows.slice(i * 7, i * 7 + 7)}</div>)} />;
}

/** Reusable proof object. No hidden test identifiers or reason payloads enter the DOM. */
export function ExamRecord({ status, simulated, task, grade, date, visible, hidden, recordPath, action }: {
  status: ExamStatus; simulated: boolean; task: Task; grade: number | null; date: string | null;
  visible: Counts | null; hidden: Counts | null;
  recordPath: string; action: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const { announce } = useOwner();
  const passed = status === "PASSED";
  const open = isOpenExam(status);
  const copy = async () => {
    try { await navigator.clipboard.writeText(new URL(recordPath, window.location.origin).href); setCopied(true); setCopyError(false); announce("Record link copied."); }
    catch { setCopyError(true); announce("Copy failed. Open Record link and copy the address."); }
  };
  return <><section className="exam-record" aria-label="Exam record">
    <header className="record-heading" aria-live="polite">
      <Seal passed={passed} />
      <div><h1 className={passed ? "record-key" : ""}>{passed ? "Acquitted" : open ? "Exam in progress" : status === "ERROR" ? "Exam interrupted" : "Not acquitted"}</h1>
        <div className="record-origin">{simulated ? <span className="sandbox">{SIMULATED_WORD}</span> : "Live run"}</div>
      </div>
    </header>
    <div className="record-meta"><span>{taskLabel(task)}</span>{grade !== null && <span>Grade {grade}</span>}
      {date && <time dateTime={date} title={date}>{localTime(date)}</time>}</div>
    <div className="record-check-bed">
      {open ? <div className="record-check-waiting"><p>Results arrive together.</p><p>Visible checks · waiting</p><p>Hidden checks · sealed</p></div> : <>
        <CheckCells counts={visible} total={visible?.total ?? 0} hidden={false} />
        <CheckCells counts={hidden} total={hidden?.total ?? 0} hidden />
      </>}
    </div>
    <footer className="record-foot">
      <div className="record-tools"><details><summary>Why hidden checks?</summary><p>The agent never sees these tests. Only pass or fail is shown.</p></details>
      {!open && <div className="record-ref"><Link to={recordPath}>Record link</Link>
        <button type="button" className="text-button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button></div>}
      </div>
    </footer>
    {copyError && <p>Copy failed. Open Record link and copy the address.</p>}
  </section><div className="owner-actions record-action">{action}</div></>;
}
