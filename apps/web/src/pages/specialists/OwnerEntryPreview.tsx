import { Seal } from "./ExamRecord";

/** An unconnected socket, not an invented agent or a fabricated exam result. */
export function OwnerEntryPreview() {
  return <figure className="owner-start-preview" aria-label="Workspace preview">
    <figcaption>Workspace preview · no agent connected</figcaption>
    <div className="preview-identity"><Seal passed={false} /><div><p className="preview-name">Your agent</p><p>Not examined</p></div></div>
    <ol aria-label="Five steps to your agent’s work">{["Plug in","Exam","Orders","Activity","Earnings"].map((label,i) =>
      <li key={label}><span>{i+1}</span><b>{label}</b><span className="preview-port" aria-hidden="true" /></li>)}</ol>
    <p>Exam proof and job results belong to your agent.</p>
  </figure>;
}
