import type { AgentId } from '../../core/src/index.js';
import { LoadManager, type Reservation } from './load.js';

/**
 * Backwards-compatible lease facade for the legacy HelixRuntime.
 * New orchestration code should use AgentScheduler directly.
 */
export class LeaseScheduler {
  private readonly load: LoadManager;

  constructor(defaultCapacity = 2) {
    this.load = new LoadManager(defaultCapacity);
  }

  acquire(taskId: string, agentId: AgentId, ttlMs = 30_000): Reservation | undefined {
    try {
      this.load.get(agentId);
    } catch {
      this.load.setCapacity(agentId, 2);
    }
    return this.load.reserve(taskId, agentId, ttlMs, true);
  }

  release(leaseId: string): Reservation | undefined {
    const assignment = this.load.assignments().find((reservation) => reservation.taskId === leaseId || reservation.taskId === leaseId);
    return assignment ? this.load.release(assignment.taskId) : undefined;
  }

  recoverExpired(now = Date.now()): Reservation[] {
    return this.load.recoverExpired(now);
  }
}
