import { id, timestamp } from '../../core/src/index.js';
import type { ControlEvent, ExecutionTrace, ExecutionTraceDecision, ExecutionTraceStage } from './types.js';

export interface TraceStartInput { executionId: string; goalId?: string; taskId?: string; swarmId?: string; agentId?: string; nodeId?: string; parentExecutionId?: string; }

export class ExecutionTraceStore {
  private readonly traces = new Map<string, ExecutionTrace>();
  constructor(private readonly maxTraces = 1_000) {}

  start(input: TraceStartInput): ExecutionTrace {
    const trace: ExecutionTrace = { ...input, startedAt: timestamp(), status: 'running', stages: [], decisions: [], events: [], errors: [], metrics: {} };
    this.traces.set(trace.executionId, trace);
    this.trim();
    return structuredClone(trace);
  }

  get(executionId: string): ExecutionTrace | undefined { const trace = this.traces.get(executionId); return trace ? structuredClone(trace) : undefined; }
  list(limit = 100): ExecutionTrace[] { return structuredClone([...this.traces.values()].slice(-Math.max(1, limit))); }

  addStage(executionId: string, stage: ExecutionTraceStage): void { this.require(executionId).stages.push(structuredClone(stage)); }
  addDecision(executionId: string, decision: Omit<ExecutionTraceDecision, 'timestamp'> & { timestamp?: string }): void { this.require(executionId).decisions.push({ ...decision, timestamp: decision.timestamp ?? timestamp(), metadata: { ...decision.metadata }, rationale: [...decision.rationale] }); }
  addEvent(executionId: string, event: ControlEvent): void { this.require(executionId).events.push(structuredClone(event)); }
  addError(executionId: string, error: string): void { this.require(executionId).errors.push(error.slice(0, 2_000)); }
  observe(executionId: string, name: string, value: number): void { this.require(executionId).metrics[name] = value; }

  finish(executionId: string, status: Exclude<ExecutionTrace['status'], 'running'>, error?: string): ExecutionTrace {
    const trace = this.require(executionId);
    trace.status = status;
    trace.completedAt = timestamp();
    if (error) trace.errors.push(error.slice(0, 2_000));
    return structuredClone(trace);
  }

  export(executionId: string): string { return JSON.stringify(this.require(executionId), null, 2); }
  clear(): void { this.traces.clear(); }

  private require(executionId: string): ExecutionTrace { const trace = this.traces.get(executionId); if (!trace) throw new Error(`Unknown execution trace: ${executionId}`); return trace; }
  private trim(): void { while (this.traces.size > this.maxTraces) { const first = this.traces.keys().next().value as string | undefined; if (!first) break; this.traces.delete(first); } }
}
