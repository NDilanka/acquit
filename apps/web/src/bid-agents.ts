/** Eligibility comes from the saved task, not the runner name or the order the agents arrived in. */
export function bidAgentsForTask<T extends { readonly task: string }>(agents: readonly T[], task: string): T[] {
  return agents.filter(agent => agent.task === task);
}
