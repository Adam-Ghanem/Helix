import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { id } from '../../core/src/index.js';
import type { DistributedLease, DistributedLeaseOptions, LeaseStore } from './types.js';

export class MemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, DistributedLease>();
  get(leaseId: string): DistributedLease | undefined { const lease = this.leases.get(leaseId); return lease ? structuredClone(lease) : undefined; }
  findByTask(taskId: string): DistributedLease | undefined { const lease = [...this.leases.values()].find((candidate) => candidate.taskId === taskId && candidate.status === 'active'); return lease ? structuredClone(lease) : undefined; }
  put(lease: DistributedLease): void { this.leases.set(lease.leaseId, structuredClone(lease)); }
  delete(leaseId: string): void { this.leases.delete(leaseId); }
  list(): DistributedLease[] { return [...this.leases.values()].map((lease) => structuredClone(lease)); }
}

export class FileLeaseStore extends MemoryLeaseStore {
  constructor(private readonly file: string) { super(); this.restore(); }
  override put(lease: DistributedLease): void { super.put(lease); this.persist(); }
  override delete(leaseId: string): void { super.delete(leaseId); this.persist(); }
  private restore(): void { try { const value = JSON.parse(readFileSync(this.file, 'utf8')) as DistributedLease[]; for (const lease of value) super.put(lease); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  private persist(): void { mkdirSync(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(this.list(), null, 2), 'utf8'); renameSync(temporary, this.file); }
}

export class DistributedLeaseManager {
  private readonly store: LeaseStore;
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;
  private readonly fencing = new Map<string, number>();
  constructor(options: DistributedLeaseOptions = {}) { this.store = options.store ?? new MemoryLeaseStore(); this.defaultTtlMs = options.defaultTtlMs ?? 30_000; this.clock = options.clock ?? Date.now; for (const lease of this.store.list()) this.fencing.set(lease.taskId, Math.max(this.fencing.get(lease.taskId) ?? 0, lease.fencingToken)); }
  acquire(taskId: string, ownerNodeId: string, ttlMs = this.defaultTtlMs): DistributedLease | undefined { this.expire(); const current = this.store.findByTask(taskId); if (current) return undefined; const fencingToken = (this.fencing.get(taskId) ?? 0) + 1; this.fencing.set(taskId, fencingToken); const now = this.clock(); const lease: DistributedLease = { leaseId: id('dlease'), taskId, ownerNodeId, expiresAt: now + ttlMs, renewedAt: now, fencingToken, status: 'active' }; this.store.put(lease); return structuredClone(lease); }
  renew(leaseId: string, fencingToken: number, ttlMs = this.defaultTtlMs): DistributedLease { const lease = this.require(leaseId); if (lease.status !== 'active' || lease.fencingToken !== fencingToken || lease.expiresAt <= this.clock()) throw new Error('lease is expired or fenced'); lease.renewedAt = this.clock(); lease.expiresAt = this.clock() + ttlMs; this.store.put(lease); return structuredClone(lease); }
  release(leaseId: string, fencingToken: number): DistributedLease { const lease = this.require(leaseId); if (lease.status !== 'active' || lease.fencingToken !== fencingToken) throw new Error('lease is expired or fenced'); lease.status = 'released'; this.store.put(lease); return structuredClone(lease); }
  expire(now = this.clock()): DistributedLease[] { const expired: DistributedLease[] = []; for (const lease of this.store.list()) if (lease.status === 'active' && lease.expiresAt <= now) { lease.status = 'expired'; this.store.put(lease); expired.push(lease); } return expired; }
  isValid(leaseId: string, fencingToken: number, now = this.clock()): boolean { const lease = this.store.get(leaseId); return Boolean(lease && lease.status === 'active' && lease.fencingToken === fencingToken && lease.expiresAt > now); }
  get(leaseId: string): DistributedLease { return structuredClone(this.require(leaseId)); }
  list(): DistributedLease[] { this.expire(); return this.store.list(); }
  private require(leaseId: string): DistributedLease { const lease = this.store.get(leaseId); if (!lease) throw new Error(`Unknown distributed lease: ${leaseId}`); return lease; }
}
