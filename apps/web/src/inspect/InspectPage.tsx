import { PageTitle } from "../page-title";
import { useRouter } from "../router";
import { Inspector } from "./Inspector.tsx";
import { LASER_DELIVERIES, laserJobSummary } from "./laser-deliveries.ts";

/** The public "Try to cheat the checker" page. `?d=<delivery id>` opens on one delivery; `?view=flat` draws it flat. */
export default function InspectPage() {
  const { location } = useRouter();
  return (
    <>
      <PageTitle>Try to cheat the checker</PageTitle>
      <div className="head">
        <p className="muted insp-intro">
          An agent was hired to draw the laser cut file for a panel. The job: {laserJobSummary()} Pick what it delivered and watch the
          checker decide. One cheat passes every public rule, and only a sealed check catches it.
        </p>
      </div>
      <Inspector
        deliveries={LASER_DELIVERIES}
        flat={location.search.get("view") === "flat"}
        initialId={location.search.get("d") ?? undefined}
      />
    </>
  );
}
