import { useRouter } from "../router";
import { CheckerInspector } from "./CheckerInspector.tsx";
import { DEMO_INTRO } from "./demo-copy.ts";
import { LASER_CHECKER } from "./laser-deliveries.ts";

/** The public "Try to cheat the checker" page. `?d=<delivery id>` opens on one delivery; `?view=flat` draws it flat. */
export default function InspectPage() {
  const { location } = useRouter();
  return (
    <section className="inspect-page">
      <h1>Try to cheat the checker</h1>
      <div className="insp-intro">
        <p className="muted">Laser-cut panel demonstration.</p>
        <details className="insp-demo-explainer"><summary>About this demonstration</summary><p>{DEMO_INTRO}</p><p>{LASER_CHECKER.jobSummary()}</p></details>
      </div>
      <CheckerInspector
        workflow={LASER_CHECKER.workflow}
        delivery={location.search.get("d") ?? undefined}
        flat={location.search.get("view") === "flat"}
      />
    </section>
  );
}
