import { timestamp } from '../../core/src/index.js';
import type { MemoryProvenance, TaskOutcomeLearningInput } from './types.js';

const SECRET_KEY = /(api.?key|authorization|credential|password|passwd|secret|token|private.?key|cookie|env)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9]{20,}|bearer\s+[A-Za-z0-9._-]+|begin (rsa|openssh|ec|pgp) private key)/i;

export function taskOutcomeProvenance(input: TaskOutcomeLearningInput): MemoryProvenance {
  return {
    sourceType: 'task-outcome',
    sourceId: input.taskId,
    timestamp: timestamp(),
    confidence: clamp(input.quality),
    agentId: input.agentId,
    ...(input.swarmId ? { swarmId: input.swarmId } : {}),
    taskId: input.taskId,
    executionId: input.executionId,
  };
}

export function sanitizeExecutionResult(value: unknown): unknown {
  return sanitize(value, 0);
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[redacted-secret]' : value.length > 8_192 ? `${value.slice(0, 8_192)}…[truncated]` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? '[redacted-secret]' : sanitize(child, depth + 1);
    return output;
  }
  return '[unsupported]';
}

export function safeErrorCategory(error: string): string {
  const normalized = error.toLowerCase();
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('permission') || normalized.includes('denied')) return 'permission';
  if (normalized.includes('budget')) return 'budget';
  if (normalized.includes('sandbox')) return 'sandbox';
  if (normalized.includes('network')) return 'network';
  return 'execution';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
