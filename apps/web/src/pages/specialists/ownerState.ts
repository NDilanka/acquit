import type { MorningReport, SpecialistAgent, StandingOrders, Task } from "./types.ts";
import { hasLiveExam, taskLabel } from "./view.ts";

export function agentTaskLabel(task: Task): string {
  return hasLiveExam(task) ? taskLabel(task) : `Simulated ${taskLabel(task)}`;
}

/** A screen visit is not evidence that an exam passed or orders were saved. */
export function completedSetup(agent: SpecialistAgent | null, orders: StandingOrders | null): ReadonlySet<number> {
  const done = new Set<number>();
  if (!agent) return done;
  done.add(1);
  if (!hasLiveExam(agent.task) || !agent.acquitted) return done;
  if (!agent.seeded) done.add(2);
  if (orders) done.add(3);
  return done;
}

export function autopilotIsOn(agent: SpecialistAgent | null, orders: StandingOrders | null): boolean {
  return !!agent && hasLiveExam(agent.task) && agent.acquitted && agent.runner === "claude-code" && orders?.autopilot === true;
}

export type WorkDate = { readonly agentId: string | null; readonly at: string };

/** Payouts only acquire an agent when a work/win record unambiguously identifies it. A bid alone cannot. */
export function reportWorkDates(report: MorningReport | null): WorkDate[] {
  if (!report) return [];
  const work = [...report.wins, ...report.verified, ...report.rejected, ...report.preApprovals];
  const dates: WorkDate[] = [...work, ...report.bids, ...report.gradeChanges];
  for (const payout of report.payouts) {
    const agents = new Set(work.filter(entry => entry.jobId === payout.jobId && entry.agentId).map(entry => entry.agentId));
    if (agents.size === 1) dates.push({ agentId: [...agents][0]!, at: payout.at });
  }
  return dates;
}

/** No-id work screens choose an Acquitted code agent by actual work, never a last-selected printer. */
export function workAgent(agents: readonly SpecialistAgent[], dates: readonly WorkDate[]): SpecialistAgent | null {
  const candidates = agents.filter(agent => agent.acquitted && hasLiveExam(agent.task));
  const latest = new Map<string, number>();
  for (const entry of dates) {
    const at = Date.parse(entry.at);
    if (entry.agentId && Number.isFinite(at)) latest.set(entry.agentId, Math.max(at, latest.get(entry.agentId) ?? -Infinity));
  }
  candidates.sort((a, b) => (latest.get(b.id) ?? -Infinity) - (latest.get(a.id) ?? -Infinity)
    || (Date.parse(b.acquittedAt ?? "") || 0) - (Date.parse(a.acquittedAt ?? "") || 0));
  return candidates[0] ?? agents.find(agent => hasLiveExam(agent.task)) ?? agents[0] ?? null;
}
