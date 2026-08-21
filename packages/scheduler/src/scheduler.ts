import type { AgentId, TaskId } from '../../core/src/index.js';
import { AgentRegistry } from '../../agents/src/index.js';
import { LoadManager, type Reservation } from './load.js';
import { AgentRouter } from './router.js';
import { PriorityTaskQueue } from './queue.js';
import { dependenciesSatisfied, type CreateTaskInput, createSchedulerTask, type SchedulerTask } from './task.js';

export type SchedulerEventName = 'task.assigned' | 'task.started' | 'task.completed' | 'task.failed' | 'task.requeued' | 'agent.overloaded' | 'agent.rebalanced';
export interface SchedulerEvent { type: SchedulerEventName; taskId?: TaskId; agentId?: AgentId; timestamp: string; data?: Record<string, unknown> }
export interface SchedulerMetrics { tasksWaiting: number; averageWaitMs: number; utilizationPercent: number; throughputPerMinute: number; completed: number; failed: number; activeAssignments: number }
export interface SchedulerOptions { defaultAgentCapacity?: number; reservationTtlMs?: number; maxAssignmentsPerTick?: number }

export class AgentScheduler {
  readonly queue = new PriorityTaskQueue();
  readonly load: LoadManager;
  private readonly tasks = new Map<TaskId, SchedulerTask>();
  private readonly listeners = new Map<SchedulerEventName, Set<(event: SchedulerEvent) => void>>();
  private readonly router: AgentRouter;
  private readonly reservationTtlMs: number;
  private readonly maxAssignmentsPerTick: number;
  private readonly startedAt = Date.now();
  private completedCount = 0;
  private failedCount = 0;
  private waitSamples: number[] = [];

  constructor(readonly registry: AgentRegistry, router = new AgentRouter(), options: SchedulerOptions = {}) {
    this.router = router;
    this.load = new LoadManager(options.defaultAgentCapacity ?? 2);
    this.reservationTtlMs = options.reservationTtlMs ?? 30_000;
    this.maxAssignmentsPerTick = options.maxAssignmentsPerTick ?? Number.POSITIVE_INFINITY;
    for (const agent of registry.list()) this.load.ensureAgent(agent);
  }

  enqueue(input: CreateTaskInput): SchedulerTask {
    const task = createSchedulerTask(input);
    if (this.tasks.has(task.id)) throw new Error(`Task already exists: ${task.id}`);
    this.tasks.set(task.id, task);
    this.queue.enqueue(task);
    return structuredClone(task);
  }

  get(taskId: TaskId): SchedulerTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return structuredClone(task);
  }

  listTasks(): SchedulerTask[] { return [...this.tasks.values()].map((task) => structuredClone(task)); }

  cancel(taskId: TaskId): SchedulerTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.assignedAgentId) this.load.release(taskId);
    task.status = 'cancelled';
    task.assignedAgentId = undefined;
    this.queue.cancel(taskId);
    return structuredClone(task);
  }

  on(type: SchedulerEventName, listener: (event: SchedulerEvent) => void): () => void {
    const listeners = this.listeners.get(type) ?? new Set<(event: SchedulerEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  tick(now = Date.now()): SchedulerTask[] {
    this.recoverExpired(now);
    this.rebalance();
    const assigned: SchedulerTask[] = [];
    let blocked = 0;
    const initialQueueSize = this.queue.size();
    while (assigned.length < this.maxAssignmentsPerTick && blocked < initialQueueSize) {
      const candidate = this.queue.dequeue((task) => {
        const current = this.tasks.get(task.id);
        return Boolean(current && current.status === 'pending' && dependenciesSatisfied(current, this.tasks));
      });
      if (!candidate) break;
      const task = this.tasks.get(candidate.id);
      if (!task || task.status !== 'pending') continue;
      const routed = this.router.select({ task, agents: this.registry.list(), load: this.load });
      if (!routed) {
        this.queue.enqueue(task);
        blocked += 1;
        continue;
      }
      const reservation = this.load.reserve(task.id, routed.agentId, this.reservationTtlMs, true);
      if (!reservation) {
        this.queue.enqueue(task);
        blocked += 1;
        this.emit({ type: 'agent.overloaded', taskId: task.id, agentId: routed.agentId, timestamp: new Date(now).toISOString() });
        continue;
      }
      task.status = 'assigned';
      task.assignedAgentId = routed.agentId;
      task.assignedAt = new Date(now).toISOString();
      task.attempts += 1;
      this.waitSamples.push(Math.max(0, now - Date.parse(task.createdAt)));
      this.registry.setStatus(routed.agentId, 'busy');
      assigned.push(structuredClone(task));
      this.emit({ type: 'task.assigned', taskId: task.id, agentId: routed.agentId, timestamp: task.assignedAt, data: { score: routed.score, attempt: task.attempts } });
    }
    return assigned;
  }

  start(taskId: TaskId): SchedulerTask {
    const task = this.require(taskId);
    if (task.status !== 'assigned') throw new Error(`Task ${taskId} is not assigned`);
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    this.emit({ type: 'task.started', taskId, agentId: task.assignedAgentId, timestamp: task.startedAt });
    return structuredClone(task);
  }

  complete(taskId: TaskId, success: boolean, error?: string): SchedulerTask {
    const task = this.require(taskId);
    const agentId = task.assignedAgentId;
    if (!agentId) throw new Error(`Task ${taskId} has no assigned agent`);
    this.load.release(taskId);
    task.assignedAgentId = undefined;
    task.completedAt = new Date().toISOString();
    if (success) {
      task.status = 'completed';
      this.completedCount += 1;
      this.registry.setStatus(agentId, 'idle');
      this.emit({ type: 'task.completed', taskId, agentId, timestamp: task.completedAt });
    } else {
      task.lastError = error ?? 'Task execution failed';
      if (task.attempts < task.maxAttempts) {
        task.status = 'pending';
        this.queue.enqueue(task);
        this.registry.setStatus(agentId, 'idle');
        this.emit({ type: 'task.requeued', taskId, agentId, timestamp: task.completedAt, data: { attempt: task.attempts } });
      } else {
        task.status = 'failed';
        this.failedCount += 1;
        this.registry.setStatus(agentId, 'idle');
        this.emit({ type: 'task.failed', taskId, agentId, timestamp: task.completedAt, data: { error: task.lastError } });
      }
    }
    return structuredClone(task);
  }

  rebalance(): SchedulerTask[] {
    const requeued: SchedulerTask[] = [];
    for (const reservation of this.load.assignments()) {
      const agent = this.registry.get(reservation.agentId);
      if (agent.status !== 'unhealthy' && agent.status !== 'offline') continue;
      const task = this.tasks.get(reservation.taskId);
      this.load.release(reservation.taskId);
      if (!task || task.status === 'completed' || task.status === 'cancelled') continue;
      task.assignedAgentId = undefined;
      if (task.attempts < task.maxAttempts) {
        task.status = 'pending';
        this.queue.enqueue(task);
        requeued.push(structuredClone(task));
        this.emit({ type: 'agent.rebalanced', taskId: task.id, agentId: reservation.agentId, timestamp: new Date().toISOString() });
      } else {
        task.status = 'failed';
        task.lastError = 'Agent became unhealthy or offline';
        this.failedCount += 1;
      }
    }
    return requeued;
  }

  metrics(): SchedulerMetrics {
    const agents = this.registry.list();
    const totalCapacity = agents.reduce((sum, agent) => sum + this.load.get(agent.id).maxConcurrentTasks, 0);
    const activeLoad = agents.reduce((sum, agent) => sum + this.load.get(agent.id).currentLoad, 0);
    const elapsedMinutes = Math.max((Date.now() - this.startedAt) / 60_000, 1 / 60_000);
    return {
      tasksWaiting: this.queue.size(),
      averageWaitMs: this.waitSamples.length ? this.waitSamples.reduce((sum, value) => sum + value, 0) / this.waitSamples.length : 0,
      utilizationPercent: totalCapacity ? (activeLoad / totalCapacity) * 100 : 0,
      throughputPerMinute: this.completedCount / elapsedMinutes,
      completed: this.completedCount,
      failed: this.failedCount,
      activeAssignments: this.load.assignments().length,
    };
  }

  assignments(): Reservation[] { return this.load.assignments(); }

  private recoverExpired(now: number): void {
    for (const reservation of this.load.recoverExpired(now)) {
      const task = this.tasks.get(reservation.taskId);
      if (!task || task.status === 'completed' || task.status === 'cancelled') continue;
      task.assignedAgentId = undefined;
      if (task.attempts < task.maxAttempts) {
        task.status = 'pending';
        this.queue.enqueue(task);
        this.emit({ type: 'task.requeued', taskId: task.id, agentId: reservation.agentId, timestamp: new Date(now).toISOString(), data: { reason: 'reservation-expired' } });
      } else {
        task.status = 'failed';
        task.lastError = 'Reservation expired';
        this.failedCount += 1;
        this.emit({ type: 'task.failed', taskId: task.id, agentId: reservation.agentId, timestamp: new Date(now).toISOString(), data: { reason: 'reservation-expired' } });
      }
      if (this.load.get(reservation.agentId).currentLoad === 0) this.registry.setStatus(reservation.agentId, 'idle');
    }
  }

  private require(taskId: TaskId): SchedulerTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}
