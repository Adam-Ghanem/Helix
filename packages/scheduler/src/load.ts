import type { AgentId, AgentProfile } from '../../core/src/index.js';

export interface AgentCapacity {
  maxConcurrentTasks: number;
  softLimitRatio: number;
  currentLoad: number;
}

export interface Reservation {
  taskId: string;
  agentId: AgentId;
  reservedAt: number;
  expiresAt: number;
}

export class LoadManager {
  private readonly capacities = new Map<AgentId, AgentCapacity>();
  private readonly reservations = new Map<string, Reservation>();

  constructor(private readonly defaultCapacity = 2, private readonly defaultSoftLimitRatio = 0.8) {}

  ensureAgent(agent: AgentProfile, maxConcurrentTasks?: number): AgentCapacity {
    const existing = this.capacities.get(agent.id);
    if (existing) return { ...existing };
    const capacity = { maxConcurrentTasks: Math.max(1, maxConcurrentTasks ?? this.defaultCapacity), softLimitRatio: this.defaultSoftLimitRatio, currentLoad: 0 };
    this.capacities.set(agent.id, capacity);
    return { ...capacity };
  }

  setCapacity(agentId: AgentId, maxConcurrentTasks: number, softLimitRatio = this.defaultSoftLimitRatio): void {
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) throw new Error('maxConcurrentTasks must be >= 1');
    if (softLimitRatio <= 0 || softLimitRatio > 1) throw new Error('softLimitRatio must be in (0, 1]');
    const current = this.capacities.get(agentId);
    this.capacities.set(agentId, { maxConcurrentTasks, softLimitRatio, currentLoad: current?.currentLoad ?? 0 });
  }

  get(agentId: AgentId): AgentCapacity {
    const capacity = this.capacities.get(agentId);
    if (!capacity) throw new Error(`Unknown capacity for agent: ${agentId}`);
    return { ...capacity };
  }

  canReserve(agentId: AgentId, hard = true): boolean {
    const capacity = this.get(agentId);
    const limit = hard ? capacity.maxConcurrentTasks : Math.max(1, Math.floor(capacity.maxConcurrentTasks * capacity.softLimitRatio));
    return capacity.currentLoad < limit;
  }

  reserve(taskId: string, agentId: AgentId, ttlMs = 30_000, hard = true): Reservation | undefined {
    if (!this.canReserve(agentId, hard)) return undefined;
    if ([...this.reservations.values()].some((reservation) => reservation.taskId === taskId)) return undefined;
    const capacity = this.get(agentId);
    const now = Date.now();
    const reservation = { taskId, agentId, reservedAt: now, expiresAt: now + ttlMs };
    this.reservations.set(taskId, reservation);
    capacity.currentLoad += 1;
    return { ...reservation };
  }

  release(taskId: string): Reservation | undefined {
    const reservation = this.reservations.get(taskId);
    if (!reservation) return undefined;
    this.reservations.delete(taskId);
    const capacity = this.get(reservation.agentId);
    capacity.currentLoad = Math.max(0, capacity.currentLoad - 1);
    return { ...reservation };
  }

  recoverExpired(now = Date.now()): Reservation[] {
    const expired: Reservation[] = [];
    for (const [taskId, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) {
        this.release(taskId);
        expired.push({ ...reservation });
      }
    }
    return expired;
  }

  assignments(): Reservation[] {
    return [...this.reservations.values()].map((reservation) => ({ ...reservation }));
  }

  utilization(agentId: AgentId): number {
    const capacity = this.get(agentId);
    return capacity.currentLoad / capacity.maxConcurrentTasks;
  }
}
