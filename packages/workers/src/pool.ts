import type { AgentId } from '../../core/src/index.js';
import { AgentRegistry } from '../../agents/src/index.js';
import { AgentScheduler } from '../../scheduler/src/index.js';
import { AgentWorker } from './worker.js';
import { SimulatedExecutor } from './executor.js';
import type { TaskExecutor, WorkerEvent, WorkerMetrics, WorkerSnapshot } from './types.js';

export interface WorkerPoolOptions { workerTimeoutMs?: number; executor?: TaskExecutor }
export class WorkerPool {
  private readonly workers = new Map<AgentId, AgentWorker>();
  private readonly listeners = new Set<(event: WorkerEvent) => void>();
  private readonly counts = { started: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0 };
  constructor(readonly scheduler: AgentScheduler, registry: AgentRegistry, options: WorkerPoolOptions = {}) {
    const executor = options.executor ?? new SimulatedExecutor();
    for (const agent of registry.list()) { const worker = new AgentWorker(agent.id, scheduler, executor, options.workerTimeoutMs); worker.on((event) => { if (event.type === 'worker.started') this.counts.started++; if (event.type === 'worker.completed') this.counts.completed++; if (event.type === 'worker.failed') this.counts.failed++; if (event.type === 'worker.timeout') this.counts.timedOut++; if (event.type === 'worker.cancelled') this.counts.cancelled++; this.emit(event); }); this.workers.set(agent.id, worker); }
  }
  on(listener: (event: WorkerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  tick(): Promise<void[]> {
    const assigned = this.scheduler.tick();
    this.emit({ type: 'pool.tick', timestamp: new Date().toISOString(), data: { assigned: assigned.length } });
    const chains = new Map<AgentId, Promise<void>>();
    for (const task of assigned) {
      const agentId = task.assignedAgentId!;
      const worker = this.workers.get(agentId);
      if (!worker) throw new Error(`No worker registered for agent ${agentId}`);
      const previous = chains.get(agentId) ?? Promise.resolve();
      chains.set(agentId, previous.then(() => worker.run(task.id)).then(() => undefined));
    }
    return Promise.all([...chains.values()]);
  }
  async runOnce(options: { awaitAll?: boolean } = {}): Promise<void> { const promise = this.tick(); if (options.awaitAll !== false) await promise; }
  async drain(maxTicks = 10_000): Promise<void> { for (let i = 0; i < maxTicks; i++) { if (this.scheduler.queue.size() === 0 && this.scheduler.assignments().length === 0) return; await this.tick(); } throw new Error('Worker pool drain exceeded maxTicks'); }
  snapshots(): WorkerSnapshot[] { return [...this.workers.values()].map((worker) => worker.snapshot()); }
  metrics(): WorkerMetrics { const active = this.snapshots().filter((worker) => worker.status === 'busy').length; return { ...this.counts, active }; }
  private emit(event: WorkerEvent): void { for (const listener of this.listeners) listener(event); }
}
