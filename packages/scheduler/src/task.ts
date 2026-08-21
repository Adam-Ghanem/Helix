import { id, timestamp, type AgentId, type TaskId } from '../../core/src/index.js';

export type SchedulerTaskStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskUrgency = 'low' | 'normal' | 'high' | 'critical';

export interface SchedulerTask {
  id: TaskId;
  title: string;
  description: string;
  requiredCapabilities: string[];
  priority: number;
  urgency: TaskUrgency;
  estimatedComplexity: number;
  status: SchedulerTaskStatus;
  createdAt: string;
  assignedAgentId?: AgentId;
  dependencies: TaskId[];
  attempts: number;
  maxAttempts: number;
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  requiredCapabilities?: string[];
  priority?: number;
  urgency?: TaskUrgency;
  estimatedComplexity?: number;
  dependencies?: TaskId[];
  maxAttempts?: number;
  id?: TaskId;
}

export const URGENCY_WEIGHT: Record<TaskUrgency, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

export function createSchedulerTask(input: CreateTaskInput): SchedulerTask {
  if (!input.title.trim()) throw new Error('Task title must not be empty');
  const priority = Math.max(1, Math.min(10, Math.trunc(input.priority ?? 5)));
  const complexity = Math.max(1, Math.min(10, Math.trunc(input.estimatedComplexity ?? 5)));
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? 2));
  return {
    id: input.id ?? id('task'),
    title: input.title,
    description: input.description ?? '',
    requiredCapabilities: [...new Set(input.requiredCapabilities ?? [])],
    priority,
    urgency: input.urgency ?? 'normal',
    estimatedComplexity: complexity,
    status: 'pending',
    createdAt: timestamp(),
    dependencies: [...new Set(input.dependencies ?? [])],
    attempts: 0,
    maxAttempts,
  };
}

export function taskPriorityScore(task: SchedulerTask): number {
  return task.priority * 10 + URGENCY_WEIGHT[task.urgency] * 25 - task.estimatedComplexity * 0.01;
}

export function dependenciesSatisfied(task: SchedulerTask, tasks: ReadonlyMap<TaskId, SchedulerTask>): boolean {
  return task.dependencies.every((dependencyId) => tasks.get(dependencyId)?.status === 'completed');
}
