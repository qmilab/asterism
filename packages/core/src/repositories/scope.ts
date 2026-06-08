// The single chokepoint for isolation: every scoped repository method runs the
// caller-supplied agentId through this assertion before it touches the driver.
// No query is ever issued without an agentId in the filter.

export function requireAgentId(agentId: string): string {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new Error("agentId is required for every scoped query");
  }
  return agentId;
}
