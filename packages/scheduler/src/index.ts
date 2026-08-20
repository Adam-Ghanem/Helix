import { id, timestamp } from '../../core/src/index.js';

export interface Lease {
  id: string;
  taskId: string;
  workerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: number;
  attempts: number;
}

export interface SchedulerOptions {
  leaseMs?: number;
  maxConcurrency?: number;
}

export class LeaseScheduler {
  private readonly leases = new Map<string, Lease>();
  private active = 0;
  private readonly leaseMs: number;
  private readonly maxConcurrency: number;

  constructor(options: SchedulerOptions = {}) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxConcurrency = options.maxConcurrency ?? 4;
  }

  acquire(taskId: string, workerId: string): Lease | undefined {
    this.recoverExpired();
    if (this.active >= this.maxConcurrency) return undefined;
    if ([...this.leases.values()].some((lease) => lease.taskId === taskId)) return undefined;
    const now = Date.now();
    const lease: Lease = { id: id('lease'), taskId, workerId, acquiredAt: timestamp(), heartbeatAt: timestamp(), expiresAt: now + this.leaseMs, attempts: 1 };
    this.leases.set(lease.id, lease);
    this.active += 1;
    return structuredClone(lease);
  }

  heartbeat(leaseId: string): Lease {
    const lease = this.require(leaseId);
    if (lease.expiresAt < Date.now()) throw new Error(`Lease ${leaseId} has expired`);
    lease.heartbeatAt = timestamp();
    lease.expiresAt = Date.now() + this.leaseMs;
    return structuredClone(lease);
  }

  release(leaseId: string): void {
    if (!this.leases.delete(leaseId)) throw new Error(`Unknown lease: ${leaseId}`);
    this.active = Math.max(0, this.active - 1);
  }

  recoverExpired(now = Date.now()): Lease[] {
    const recovered: Lease[] = [];
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt < now) {
        recovered.push(structuredClone(lease));
        this.leases.delete(leaseId);
        this.active = Math.max(0, this.active - 1);
      }
    }
    return recovered;
  }

  list(): Lease[] {
    this.recoverExpired();
    return [...this.leases.values()].map((lease) => structuredClone(lease));
  }

  async run<T>(taskId: string, workerId: string, work: (lease: Lease) => Promise<T>): Promise<T> {
    const lease = this.acquire(taskId, workerId);
    if (!lease) throw new Error('No scheduler capacity or task already leased');
    try {
      const result = await work(lease);
      this.release(lease.id);
      return result;
    } catch (error) {
      this.release(lease.id);
      throw error;
    }
  }

  private require(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error(`Unknown lease: ${leaseId}`);
    return lease;
  }
}
