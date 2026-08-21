import { id, timestamp } from '../../core/src/index.js';
import type { FederationNode, FederationNodeInput, FederationNodeRegistryOptions, FederationNodeStatus, FederationTrustLevel } from './types.js';

const allowedTransitions: Record<FederationNodeStatus, FederationNodeStatus[]> = {
  joining: ['healthy', 'degraded', 'offline', 'removed'],
  healthy: ['degraded', 'draining', 'offline', 'removed'],
  degraded: ['healthy', 'draining', 'offline', 'removed'],
  draining: ['offline', 'removed'],
  offline: ['joining', 'healthy', 'removed'],
  removed: [],
};

function clone<T>(value: T): T { return structuredClone(value); }
function health(): FederationNode['health'] { return { score: 1, load: 0, latencyMs: 0, successRate: 1, observedAt: timestamp() }; }

export class NodeRegistry {
  private readonly nodes = new Map<string, FederationNode>();
  private readonly heartbeatTimeoutMs: number;
  private readonly clock: () => number;

  constructor(options: FederationNodeRegistryOptions = {}) { this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000; this.clock = options.clock ?? Date.now; }

  registerNode(input: FederationNodeInput): FederationNode {
    if (!input.name.trim()) throw new Error('node name is required');
    if (!/^https?:\/\//.test(input.endpoint) && !/^in-memory:\/\//.test(input.endpoint)) throw new Error('Federation endpoint must use http(s) or in-memory://');
    const existing = input.id ? this.nodes.get(input.id) : undefined;
    if (existing?.status === 'removed') throw new Error(`node ${input.id} has been removed`);
    const node: FederationNode = { id: input.id ?? id('node'), name: input.name.trim(), endpoint: input.endpoint, role: input.role, capabilities: [...new Set(input.capabilities)], status: input.status ?? existing?.status ?? 'joining', health: existing?.health ?? health(), lastHeartbeat: existing?.lastHeartbeat ?? timestamp(), metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) }, version: input.version ?? existing?.version ?? '0.14.0', trustLevel: input.trustLevel ?? existing?.trustLevel ?? 'LIMITED' };
    this.nodes.set(node.id, node);
    return clone(node);
  }

  removeNode(nodeId: string): FederationNode { return this.transition(nodeId, 'removed'); }
  getNode(nodeId: string): FederationNode { const node = this.nodes.get(nodeId); if (!node) throw new Error(`Unknown federation node: ${nodeId}`); return clone(node); }
  listNodes(): FederationNode[] { this.refreshStale(); return [...this.nodes.values()].map(clone); }
  heartbeat(nodeId: string, at = this.clock()): FederationNode { const node = this.require(nodeId); if (node.status === 'removed') throw new Error(`node ${nodeId} has been removed`); node.lastHeartbeat = new Date(at).toISOString(); node.health.observedAt = node.lastHeartbeat; if (node.status === 'joining' || node.status === 'degraded' || node.status === 'offline') node.status = 'healthy'; return clone(node); }
  markOffline(nodeId: string): FederationNode { return this.transition(nodeId, 'offline'); }
  markDraining(nodeId: string): FederationNode { return this.transition(nodeId, 'draining'); }
  transition(nodeId: string, next: FederationNodeStatus): FederationNode { const node = this.require(nodeId); if (node.status === next) return clone(node); if (!allowedTransitions[node.status].includes(next)) throw new Error(`invalid node transition ${node.status} -> ${next}`); node.status = next; return clone(node); }
  selectHealthyNodes(requiredCapabilities: string[] = [], trustLevel?: FederationTrustLevel): FederationNode[] { this.refreshStale(); return [...this.nodes.values()].filter((node) => node.status === 'healthy' && requiredCapabilities.every((capability) => node.capabilities.includes(capability)) && (!trustLevel || trustRank(node.trustLevel) >= trustRank(trustLevel))).sort((left, right) => right.health.score - left.health.score || left.health.load - right.health.load || left.id.localeCompare(right.id)).map(clone); }
  setHealth(nodeId: string, input: Partial<FederationNode['health']>): FederationNode { const node = this.require(nodeId); node.health = { ...node.health, ...input, score: Math.max(0, Math.min(1, input.score ?? node.health.score)), load: Math.max(0, Math.min(1, input.load ?? node.health.load)), observedAt: new Date(this.clock()).toISOString() }; if (node.status === 'healthy' && node.health.score < 0.4) node.status = 'degraded'; return clone(node); }
  inspectTrust(nodeId: string): { nodeId: string; trustLevel: FederationTrustLevel; remotePrivileges: string[]; inheritedLocalPrivileges: string[] } { const node = this.require(nodeId); const remotePrivileges = node.trustLevel === 'ADMIN' ? ['federation:send', 'federation:dispatch'] : node.trustLevel === 'TRUSTED' ? ['federation:send'] : []; return { nodeId, trustLevel: node.trustLevel, remotePrivileges, inheritedLocalPrivileges: [] }; }
  private refreshStale(): void { const now = this.clock(); for (const node of this.nodes.values()) { if (node.status !== 'removed' && now - Date.parse(node.lastHeartbeat) > this.heartbeatTimeoutMs && node.status !== 'offline') node.status = 'offline'; } }
  private require(nodeId: string): FederationNode { const node = this.nodes.get(nodeId); if (!node) throw new Error(`Unknown federation node: ${nodeId}`); return node; }
}

function trustRank(level: FederationTrustLevel): number { return { UNTRUSTED: 0, LIMITED: 1, TRUSTED: 2, ADMIN: 3 }[level]; }
