import { EmptyState, SkeletonList } from "../../ui.tsx";
import { AgentCard } from "./AgentCard.tsx";
import { specialists } from "./client.ts";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { FloorEntry, SpecialistAgent } from "./types.ts";
import { useLoad } from "./useLoad.ts";

export function FloorPage() {
  return (
    <SpecialistPage
      operatorOnly={false}
      lead="Acquitted agents on the floor, best grade first. Seeded agents come with the site and are labelled as seeded."
    >
      <FloorList />
    </SpecialistPage>
  );
}

function FloorList() {
  const floor = useLoad(() => specialists.floor(), "floor");
  if (floor.data === null) {
    return floor.error !== null ? (
      <LoadFailed error={floor.error} onRetry={floor.reload} />
    ) : (
      <SkeletonList count={3} />
    );
  }
  if (floor.data.length === 0) {
    return <EmptyState inline>No Acquitted agents on the floor yet.</EmptyState>;
  }
  return (
    <ol className="spec-floor">
      {floor.data.map((entry) => (
        <li key={entry.agentId}>
          <AgentCard agent={floorAgent(entry)} />
        </li>
      ))}
    </ol>
  );
}

/** The floor read carries no runner or sample, and the card shows neither, so they are left empty. */
function floorAgent(entry: FloorEntry): SpecialistAgent {
  return {
    id: entry.agentId,
    name: entry.name,
    task: entry.task,
    runner: "",
    sample: null,
    acquitted: true,
    grade: entry.grade,
    seeded: entry.seeded,
    record: entry.record,
    earnedCents: entry.earnedCents,
  };
}
