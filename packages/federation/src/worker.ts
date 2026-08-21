import type { AgentId } from '../../core/src/index.js';
import type { NodeRegistry } from './node-registry.js';

export type FederatedWorkerStatus = 'idle' | 'busy' | 'draining' | 'offline';
export interface FederatedWorkerDescriptor { workerId: string; agentId?: AgentId; nodeId: string; capacity: number; capabilities: string[]; status: FederatedWorkerStatus; load: number; }

export class FederatedWorkerRegistry {
  private readonly workers = new Map<string, FederatedWorkerDescriptor>();
  constructor(private readonly nodes: NodeRegistry) {}
  register(worker: Omit<FederatedWorkerDescriptor, 'load'> & { load?: number }): FederatedWorkerDescriptor { this.nodes.getNode(worker.nodeId); const descriptor: FederatedWorkerDescriptor = { ...worker, capabilities: [...new Set(worker.capabilities)], load: Math.max(0, Math.min(1, worker.load ?? 0)) }; this.workers.set(descriptor.workerId, descriptor); return structuredClone(descriptor); }
  get(workerId: string): FederatedWorkerDescriptor { const worker = this.workers.get(workerId); if (!worker) throw new Error(`Unknown federated worker: ${workerId}`); return structuredClone(worker); }
  list(nodeId?: string): FederatedWorkerDescriptor[] { return [...this.workers.values()].filter((worker) => !nodeId || worker.nodeId === nodeId).map((worker) => structuredClone(worker)); }
  update(workerId: string, input: Partial<Pick<FederatedWorkerDescriptor, 'capacity' | 'status' | 'load' | 'capabilities'>>): FederatedWorkerDescriptor { const worker = this.workers.get(workerId); if (!worker) throw new Error(`Unknown federated worker: ${workerId}`); if (input.capacity !== undefined) worker.capacity = Math.max(1, Math.floor(input.capacity)); if (input.status !== undefined) worker.status = input.status; if (input.load !== undefined) worker.load = Math.max(0, Math.min(1, input.load)); if (input.capabilities !== undefined) worker.capabilities = [...new Set(input.capabilities)]; return structuredClone(worker); }
  select(requiredCapabilities: string[], nodeId?: string): FederatedWorkerDescriptor[] { return this.list(nodeId).filter((worker) => worker.status === 'idle' && requiredCapabilities.every((capability) => worker.capabilities.includes(capability))).sort((left, right) => left.load - right.load || right.capacity - left.capacity || left.workerId.localeCompare(right.workerId)); }
}
