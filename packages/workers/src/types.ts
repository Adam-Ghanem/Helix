import type { AgentId } from '../../core/src/index.js';
import type { SchedulerTask } from '../../scheduler/src/index.js';

export type WorkerStatus = 'idle' | 'busy' | 'draining' | 'stopped';
export interface WorkerTaskContext { task: SchedulerTask; agentId: AgentId; signal: AbortSignal }
export interface ExecutionResult { success: boolean; quality: number; latencyMs: number; tokens: number; error?: string; timedOut?: boolean }
export interface TaskExecutor { execute(context: WorkerTaskContext): Promise<ExecutionResult> }
export type WorkerEventName = 'worker.started' | 'worker.completed' | 'worker.failed' | 'worker.timeout' | 'worker.cancelled' | 'pool.tick';
export interface WorkerEvent { type: WorkerEventName; agentId?: AgentId; taskId?: string; timestamp: string; data?: Record<string, unknown> }
export interface WorkerMetrics { started: number; completed: number; failed: number; timedOut: number; cancelled: number; active: number }
export interface WorkerSnapshot { agentId: AgentId; status: WorkerStatus; taskId?: string }
