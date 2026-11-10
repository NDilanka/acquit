import type { ExamRead, SpecialistAgent } from "./types.ts";

/** Only an owned, named acquittal's passed exam is eligible; a replay or another exam is never a substitute. */
export function recordExamId(publicAgent: SpecialistAgent | null, owned: readonly SpecialistAgent[] | null): string | null {
  if (!publicAgent?.acquitted || publicAgent.seeded || publicAgent.task !== "code") return null;
  const mine = owned?.find(agent => agent.id === publicAgent.id && agent.acquitted && !agent.seeded);
  return mine ? publicAgent.examId ?? mine.examId ?? null : null;
}
export function recordCounts(exam: ExamRead | null, id: string | null) {
  return id && exam?.exam.id === id && exam.acquitted && exam.exam.status === "PASSED"
    ? { visible:exam.exam.visible,hidden:exam.exam.hidden } : null;
}
