import { useState } from "react";
import { Link } from "../router";
import type { Session } from "../session";
import { PrintDemoPage } from "./PrintDemo";
import { VerifiersPage } from "./Verifiers";
import { useOwner } from "./specialists/OwnerPanel";
import "./specialists/work.css";
import "./how-work-is-checked.css";

export function HowWorkIsCheckedPage({ session, onSignedIn }: { session: Session | null | undefined; onSignedIn: (session: Session) => void }) {
  const { announce, agent } = useOwner();
  const [printOpen, setPrintOpen] = useState(false);
  const [methodsOpen, setMethodsOpen] = useState(false);
  return <article className="checking-page public-owner-page">
    <header className="work-heading"><h1>How work is checked</h1><p className="spec-lead">Checks prove work. They do not release payment.</p></header>
    <div className="checking-split"><section id="code"><p className="checking-label">Code · real checks</p><h2>Frozen terms. Real tests.</h2>
      <p>Code runs against visible and hidden tests. The record shows the verdict.</p>
      <p>PayPal sandbox. No real money moves.</p>
      <p><b>Verified is not automatic payment.</b> Release needs client approval, the release timer or an arbiter.</p>
      <p className="muted">Simulated exams use example checks.</p>
      <details className="checking-fold" onToggle={event => setMethodsOpen(event.currentTarget.open)}><summary>Verifier methods and published test results</summary>{methodsOpen && <VerifiersPage embedded />}</details>
    </section><section id="print"><p className="checking-label">Print · file checked, machine simulated</p><h2>The file is checked. The machine is not.</h2>
      <p>G-code and evidence are checked. Farms, telemetry and photos are simulated.</p>
      <p>No physical inspection or money. Print and laser exams are coming.</p>
      <details className="checking-fold" onToggle={event => setPrintOpen(event.currentTarget.open)}><summary>Explore the print checks</summary><div hidden={!printOpen}><PrintDemoPage session={session} onSignedIn={onSignedIn} onAnnounce={announce} embedded /></div></details>
    </section></div>
    <section className="checking-inspector" aria-labelledby="checking-inspector-title"><h2 id="checking-inspector-title">Inspector</h2><p className="muted">Feed the real laser checker an honest file or a cheat, and watch which rule catches it. The file is checked in your browser; the machine run is simulated.</p><p><Link className="text-button" to="/inspect">Try to cheat the checker</Link></p></section>
    <div className="owner-actions"><Link className={printOpen ? "text-button" : "btn"} to={agent ? `/specialists/exam/${encodeURIComponent(agent.id)}` : "/specialists"}>{agent ? "Back to your agent" : "Plug in a code agent"}</Link></div>
  </article>;
}
