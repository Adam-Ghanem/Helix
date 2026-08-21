import type { AgentId } from '../../core/src/index.js';
import type { AgentScheduler } from '../../scheduler/src/index.js';
import type { ExecutionResult, TaskExecutor, WorkerEvent, WorkerSnapshot, WorkerStatus } from './types.js';

export class AgentWorker {
  private status: WorkerStatus = 'idle';
  private taskId: string | undefined;
  private controller: AbortController | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<(event: WorkerEvent) => void>();
  constructor(readonly agentId: AgentId, private readonly scheduler: AgentScheduler, private readonly executor: TaskExecutor, private readonly timeoutMs = 30_000) {}
  on(listener: (event: WorkerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot(): WorkerSnapshot { return { agentId: this.agentId, status: this.status, ...(this.taskId ? { taskId: this.taskId } : {}) }; }
  async run(taskId: string): Promise<ExecutionResult> {
    if (this.status !== 'idle') throw new Error(`Worker ${this.agentId} is not idle`);
    const task = this.scheduler.start(taskId);
    if (task.assignedAgentId !== this.agentId) throw new Error(`Task ${taskId} belongs to another agent`);
    this.status = 'busy'; this.taskId = taskId; this.controller = new AbortController();
    let timedOut = false;
    this.timeout = setTimeout(() => { timedOut = true; this.controller?.abort(); }, this.timeoutMs);
    this.emit('worker.started', taskId);
    try {
      const result = await this.executor.execute({ task, agentId: this.agentId, signal: this.controller.signal });
      const final = { ...result, ...(timedOut ? { timedOut: true } : {}) };
      this.scheduler.complete(taskId, final.success && !timedOut, final.error ?? (timedOut ? 'Worker timeout' : undefined));
      this.scheduler.registry.recordOutcome(this.agentId, { taskType: task.requiredCapabilities[0] ?? 'general', domain: task.requiredCapabilities[0] ?? 'general', success: final.success && !timedOut, quality: final.quality, latencyMs: final.latencyMs, tokens: final.tokens, timedOut });
      if (timedOut) this.emit('worker.timeout', taskId); else if (final.success) this.emit('worker.completed', taskId); else this.emit('worker.failed', taskId);
      return final;
    } finally {
      if (this.timeout !== undefined) clearTimeout(this.timeout);
      this.timeout = undefined; this.controller = undefined; this.taskId = undefined; this.status = 'idle';
    }
  }
  cancel(): void { if (!this.taskId || !this.controller) return; const id = this.taskId; this.controller.abort(); this.scheduler.complete(id, false, 'Worker cancelled'); this.emit('worker.cancelled', id); this.taskId = undefined; this.status = 'idle'; }
  stop(): void { this.cancel(); this.status = 'stopped'; }
  private emit(type: WorkerEvent['type'], taskId: string): void { const event = { type, agentId: this.agentId, taskId, timestamp: new Date().toISOString() }; for (const listener of this.listeners) listener(event); }
}
