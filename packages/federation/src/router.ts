import type { FederationNode } from './index.js';

export class FederationRouter {
  select(nodes: FederationNode[], requiredCapabilities: string[], now = Date.now()): FederationNode | undefined {
    const required = [...new Set(requiredCapabilities)];
    const candidates = nodes.filter((node) => node.status === 'online' && required.every((capability) => node.capabilities.includes(capability)));
    candidates.sort((left, right) => {
      const loadDelta = (left.load ?? 0) - (right.load ?? 0);
      if (loadDelta !== 0) return loadDelta;
      const leftHeartbeat = heartbeatAge(left.lastHeartbeat, now);
      const rightHeartbeat = heartbeatAge(right.lastHeartbeat, now);
      if (leftHeartbeat !== rightHeartbeat) return leftHeartbeat - rightHeartbeat;
      return left.id.localeCompare(right.id);
    });
    return candidates[0] ? structuredClone(candidates[0]) : undefined;
  }
}

function heartbeatAge(lastHeartbeat: string | undefined, now: number): number {
  if (!lastHeartbeat) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(lastHeartbeat);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - parsed);
}
