import type { FederationNode, FederationRoutingDecision, FederationRoutingTask, FederationTrustLevel } from './types.js';
import { NodeRegistry } from './node-registry.js';

function trustRank(level: FederationTrustLevel): number { return { UNTRUSTED: 0, LIMITED: 1, TRUSTED: 2, ADMIN: 3 }[level]; }

export class FederationRouter {
  constructor(private readonly nodes: NodeRegistry, readonly localNodeId: string) {}
  route(task: FederationRoutingTask): FederationRoutingDecision {
    const requiredTrust = task.trustLevel ?? task.securityContext.trustLevel;
    const candidates = this.nodes.selectHealthyNodes(task.requiredCapabilities, requiredTrust).filter((node) => node.id === this.localNodeId || node.role !== 'coordinator');
    if (!candidates.length) throw new Error(`no healthy federation node satisfies task ${task.taskId}`);
    const ranked = candidates.map((node) => ({ node, score: this.score(node, task), rationale: this.rationale(node, task) })).sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
    const selected = ranked[0]!;
    return { taskId: task.taskId, nodeId: selected.node.id, remote: selected.node.id !== this.localNodeId, score: Number(selected.score.toFixed(4)), rationale: selected.rationale };
  }
  rank(task: FederationRoutingTask): FederationRoutingDecision[] { const selected = this.route(task); return [selected]; }
  private score(node: FederationNode, task: FederationRoutingTask): number { const locality = task.locality === 'remote' ? (node.id === this.localNodeId ? 0 : 0.1) : task.locality === 'local' ? (node.id === this.localNodeId ? 0.3 : 0) : (node.id === this.localNodeId ? 0.15 : 0); const trust = trustRank(node.trustLevel) / 3 * 0.15; const health = node.health.score * 0.35; const load = (1 - node.health.load) * 0.25; const latency = Math.max(0, 1 - Math.min(1, node.health.latencyMs / 5_000)) * 0.15; return health + load + latency + trust + locality; }
  private rationale(node: FederationNode, task: FederationRoutingTask): string[] { return [`capabilities=${task.requiredCapabilities.join(',') || 'none'}`, `health=${node.health.score.toFixed(3)}`, `load=${node.health.load.toFixed(3)}`, `latencyMs=${node.health.latencyMs.toFixed(1)}`, `trust=${node.trustLevel}`, node.id === this.localNodeId ? 'locality bonus applied' : 'remote node selected by bounded score', 'authorization context preserved; no privilege inheritance']; }
}
