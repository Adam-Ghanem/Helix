import type { AgentId } from '../../core/src/index.js';
import { LoadManager, type Reservation } from './load.js';

export interface Lease extends Reservation { id: string }

/** Backwards-compatible lease facade for the legacy HelixRuntime. New orchestration code should use AgentScheduler directly. */
export class LeaseScheduler {
  private readonly load: LoadManager;

  constructor(defaultCapacity = 2) { this.load = new LoadManager(defaultCapacity); }

  acquire(taskId: string, agentId: AgentId, ttlMs = 30_000): Lease | undefined {
    try { this.load.get(agentId); } catch { this.load.setCapacity(agentId, 2); }
    const reservation = this.load.reserve(taskId, agentId, ttlMs, true);
    return reservation ? { ...reservation, id: taskId } : undefined;
  }

  release(leaseId: string): Reservation | undefined { return this.load.release(leaseId); }
  recoverExpired(now = Date.now()): Reservation[] { return this.load.recoverExpired(now); }
}
