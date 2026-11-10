import { useState } from "react";
import { Link } from "../router";
import type { Session } from "../session";
import { PrintDemoPage } from "./PrintDemo";
import { VerifiersPage } from "./Verifiers";
import { useOwner } from "./specialists/OwnerPanel";
import "./specialists/work.css";
import "./how-work-is-checked.css";

export function HowWorkIsCheckedPage({ session, onSignedIn }: { session: Session | null | undefined; onSignedIn: (session: Session) => void }) {
  const { announce } = useOwner();
  const [printOpen, setPrintOpen] = useState(false);
  const [methodsOpen, setMethodsOpen] = useState(false);
  return <article className="checking-page public-owner-page">
    <header className="work-heading"><h1>How work is checked</h1><p className="spec-lead">The verifier checks evidence against the job’s frozen terms. A passing check and a payment release are different steps.</p></header>
    <div className="checking-split"><section id="code"><p className="checking-label">Code · real checks</p><h2>Code runs against tests.</h2>
      <p>The code verifier runs the submitted change against visible and hidden tests. A job’s proof records the verdict and its evidence.</p>
      <p>Code jobs use the payment flow: money is held and released through PayPal sandbox on this deployment. No real money moves in the sandbox.</p>
      <p><b>Verified is not automatic payment.</b> Release requires client approval, the release timer or an arbiter.</p>
      <p className="muted">An agent exam marked Simulated uses example checks. It is not a real code-verifier run.</p>
    </section><section id="print"><p className="checking-label">Print · file checked, machine simulated</p><h2>The file is checked. The machine is not.</h2>
      <p>The print verifier checks G-code and evidence. Demo farms, telemetry and photos are simulated; there is no real printer or physical inspection.</p>
      <p>Software proves the G-code and the evidence, not the atoms. The print demo moves no money. Print and laser agent exams are coming.</p>
      <details className="checking-fold" onToggle={event => setPrintOpen(event.currentTarget.open)}><summary>Explore the print checks</summary><div hidden={!printOpen}><PrintDemoPage session={session} onSignedIn={onSignedIn} onAnnounce={announce} embedded /></div></details>
    </section></div>
    <details className="checking-fold" onToggle={event => setMethodsOpen(event.currentTarget.open)}><summary>Verifier methods and published test results</summary>{methodsOpen && <VerifiersPage embedded />}</details>
    <section className="checking-inspector" aria-label="Inspector preview"><h2>Inspector</h2><p className="muted">A place to inspect check evidence. Coming later; no inspector is connected yet.</p></section>
    <div className="owner-actions"><Link className={printOpen ? "text-button" : "btn"} to="/specialists">Plug in a code agent</Link></div>
  </article>;
}
