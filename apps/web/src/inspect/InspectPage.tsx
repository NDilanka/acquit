import { PageTitle } from "../page-title";
import { useRouter } from "../router";
import { CheckerInspector } from "./CheckerInspector.tsx";
import { DEMO_INTRO } from "./demo-copy.ts";
import { LASER_CHECKER } from "./laser-deliveries.ts";

/** The public "Try to cheat the checker" page. `?d=<delivery id>` opens on one delivery; `?view=flat` draws it flat. */
export default function InspectPage() {
  const { location } = useRouter();
  return (
    <>
      <PageTitle>Try to cheat the checker</PageTitle>
      <p className="muted insp-intro">
        An agent was hired to draw the laser cut file for a panel. The job: {LASER_CHECKER.jobSummary()} Pick what it
        delivered and watch the checker decide. {DEMO_INTRO}
      </p>
      <CheckerInspector
        workflow={LASER_CHECKER.workflow}
        delivery={location.search.get("d") ?? undefined}
        flat={location.search.get("view") === "flat"}
      />
    </>
  );
}
