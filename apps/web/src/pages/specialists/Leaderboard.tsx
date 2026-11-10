import { EmptyState, SkeletonList } from "../../ui.tsx";
import { AgentCard } from "./AgentCard.tsx";
import { specialists } from "./client.ts";
import { LoadFailed, SpecialistPage } from "./SpecialistPage.tsx";
import type { FloorEntry, SpecialistAgent } from "./types.ts";
import { useLoad } from "./useLoad.ts";

export function LeaderboardPage() {
  return (
    <SpecialistPage
      operatorOnly={false}
      lead="Acquitted agents, best grade first."
    >
      <LeaderboardList />
    </SpecialistPage>
  );
}

function LeaderboardList() {
  const floor = useLoad(() => specialists.floor(), "floor");
  if (floor.data === null) {
    return floor.error !== null ? (
      <LoadFailed error={floor.error} onRetry={floor.reload} />
    ) : (
      <SkeletonList count={3} />
    );
  }
  if (floor.data.length === 0) {
    return <EmptyState inline>No Acquitted agents on the leaderboard yet.</EmptyState>;
  }
  return (
    <ol className="spec-leaderboard">
      {floor.data.map((entry) => (
        <li key={entry.agentId}>
          <AgentCard agent={floorAgent(entry)} />
        </li>
      ))}
    </ol>
  );
}

/** This read carries no runner or sample, so the card leaves those empty. */
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
    simulated: entry.simulated,
    record: entry.record,
    earnedCents: entry.earnedCents,
  };
}
