import { ExecutionRecord, TaskId, TaskRecord, TaskStatus, id } from '../../core/src/index.js';

export interface TaskSpec {
  title: string;
  description: string;
  dependencies?: TaskId[];
  estimatedMs?: number;
}

export type ReplacementTaskSpec = Omit<TaskSpec, 'dependencies'>;

export interface TaskSupersession {
  superseded: TaskRecord;
  replacements: TaskRecord[];
}

export interface ReplanProposal {
  reason: string;
  replacements: ReplacementTaskSpec[];
}

export interface ReplanContext {
  execution: ExecutionRecord;
  failedTask: TaskRecord;
  tasks: TaskRecord[];
  revision: number;
  remainingTaskCapacity: number;
  failureReason: string;
}

export interface RuntimeReplanner {
  replan(context: ReplanContext): Promise<ReplanProposal | null>;
}

export class DeterministicFailureReplanner implements RuntimeReplanner {
  async replan(context: ReplanContext): Promise<ReplanProposal | null> {
    if (context.remainingTaskCapacity < 1) return null;
    return {
      reason: `Repair failed task ${context.failedTask.title}`,
      replacements: [{
        title: `Repair ${context.failedTask.title}`,
        description: `Recover the failed task without repeating completed work. Previous failure: ${context.failureReason}`,
      }],
    };
  }
}

export class TaskGraph {
  private readonly tasks = new Map<TaskId, TaskRecord>();
  private readonly estimates = new Map<TaskId, number>();

  constructor(tasks: TaskRecord[] = []) {
    for (const task of tasks) this.tasks.set(task.id, structuredClone(task));
    this.validate();
  }

  addTask(spec: TaskSpec, executionId: string): TaskRecord {
    const dependencies = [...(spec.dependencies ?? [])];
    for (const dependency of dependencies) {
      if (!this.tasks.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
    }
    const task: TaskRecord = {
      id: id('task'),
      executionId,
      title: spec.title,
      description: spec.description,
      dependencies,
      status: dependencies.length ? 'pending' : 'ready',
      attempts: 0,
    };
    this.tasks.set(task.id, task);
    this.estimates.set(task.id, spec.estimatedMs ?? 1_000);
    try {
      this.validate();
    } catch (error) {
      this.tasks.delete(task.id);
      this.estimates.delete(task.id);
      throw error;
    }
    return structuredClone(task);
  }

  removeTask(taskId: TaskId): void {
    if (!this.tasks.has(taskId)) throw new Error(`Unknown task: ${taskId}`);
    if ([...this.tasks.values()].some((task) => task.dependencies.includes(taskId))) {
      throw new Error(`Cannot remove ${taskId}: other tasks depend on it`);
    }
    this.tasks.delete(taskId);
    this.estimates.delete(taskId);
  }

  supersedeFailed(taskId: TaskId, replacements: ReplacementTaskSpec[], executionId: string): TaskSupersession {
    const taskSnapshot = new Map<TaskId, TaskRecord>([...this.tasks.entries()].map(([key, task]) => [key, structuredClone(task)]));
    const estimateSnapshot = new Map(this.estimates);
    try {
      const failed = this.require(taskId);
      if (failed.status !== 'failed') throw new Error(`Task ${taskId} must be failed before it can be superseded`);
      if (!replacements.length) throw new Error('Task supersession requires at least one replacement');
      if (failed.executionId !== executionId) throw new Error(`Task ${taskId} does not belong to execution ${executionId}`);

      const originalDependencies = [...failed.dependencies];
      const downstream = [...this.tasks.values()].filter((task) => task.id !== taskId && task.status !== 'completed' && task.dependencies.includes(taskId));
      const created: TaskRecord[] = [];
      let previousTaskId: TaskId | undefined;

      for (const replacement of replacements) {
        if (!replacement.title.trim()) throw new Error('Replacement task title is required');
        if (!replacement.description.trim()) throw new Error('Replacement task description is required');
        if (replacement.estimatedMs !== undefined && (!Number.isFinite(replacement.estimatedMs) || replacement.estimatedMs <= 0)) throw new Error('Replacement task estimatedMs must be greater than zero');
        const dependencies = previousTaskId ? [previousTaskId] : originalDependencies;
        const createdTask: TaskRecord = {
          id: id('task'),
          executionId,
          title: replacement.title,
          description: replacement.description,
          dependencies: [...dependencies],
          status: dependencies.length ? 'pending' : 'ready',
          attempts: 0,
        };
        this.tasks.set(createdTask.id, createdTask);
        this.estimates.set(createdTask.id, replacement.estimatedMs ?? 1_000);
        created.push(createdTask);
        previousTaskId = createdTask.id;
      }

      const finalReplacementId = previousTaskId!;
      for (const dependent of downstream) {
        dependent.dependencies = dependent.dependencies.map((dependency) => dependency === taskId ? finalReplacementId : dependency);
      }
      failed.status = 'skipped';
      this.refreshReadiness();
      this.validate();
      return { superseded: structuredClone(failed), replacements: created.map((task) => structuredClone(task)) };
    } catch (error) {
      this.tasks.clear();
      for (const [key, task] of taskSnapshot) this.tasks.set(key, task);
      this.estimates.clear();
      for (const [key, estimate] of estimateSnapshot) this.estimates.set(key, estimate);
      throw error;
    }
  }

  setStatus(taskId: TaskId, status: TaskStatus): void {
    const task = this.require(taskId);
    if (status === 'ready' && !this.dependenciesCompleted(task)) throw new Error(`Task ${taskId} is not ready`);
    task.status = status;
    this.refreshReadiness();
  }

  update(taskId: TaskId, patch: Partial<Pick<TaskRecord, 'assignedAgentId' | 'attempts' | 'result' | 'error'>>): void {
    const task = this.require(taskId);
    Object.assign(task, patch);
  }

  retryFailed(): TaskId[] {
    const retried: TaskId[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'failed') continue;
      delete task.error;
      task.status = this.dependenciesCompleted(task) ? 'ready' : 'pending';
      retried.push(task.id);
    }
    return retried;
  }

  resetRunningForRecovery(): TaskId[] {
    const reset: TaskId[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      task.status = this.dependenciesCompleted(task) ? 'ready' : 'pending';
      reset.push(task.id);
    }
    return reset;
  }

  get(taskId: TaskId): TaskRecord {
    return structuredClone(this.require(taskId));
  }

  all(): TaskRecord[] {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }

  ready(): TaskRecord[] {
    this.refreshReadiness();
    return this.all().filter((task) => task.status === 'ready');
  }

  topologicalOrder(): TaskId[] {
    const indegree = new Map<TaskId, number>();
    const outgoing = new Map<TaskId, TaskId[]>();
    for (const task of this.tasks.values()) {
      indegree.set(task.id, task.dependencies.length);
      for (const dependency of task.dependencies) {
        const list = outgoing.get(dependency) ?? [];
        list.push(task.id);
        outgoing.set(dependency, list);
      }
    }
    const queue = [...this.tasks.values()].filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id);
    const ordered: TaskId[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      ordered.push(current);
      for (const child of outgoing.get(current) ?? []) {
        const next = (indegree.get(child) ?? 1) - 1;
        indegree.set(child, next);
        if (next === 0) queue.push(child);
      }
    }
    if (ordered.length !== this.tasks.size) throw new Error('Task graph contains a cycle');
    return ordered;
  }

  criticalPathMs(): number {
    const longest = new Map<TaskId, number>();
    for (const taskId of this.topologicalOrder()) {
      const task = this.require(taskId);
      const dependencyMax = Math.max(0, ...task.dependencies.map((dependency) => longest.get(dependency) ?? 0));
      longest.set(taskId, dependencyMax + (this.estimates.get(taskId) ?? 1_000));
    }
    return Math.max(0, ...longest.values());
  }

  validate(): void {
    for (const task of this.tasks.values()) {
      if (new Set(task.dependencies).size !== task.dependencies.length) throw new Error(`Duplicate dependencies in ${task.id}`);
      for (const dependency of task.dependencies) {
        if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
        if (!this.tasks.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
      }
    }
    this.topologicalOrder();
  }

  private dependenciesCompleted(task: TaskRecord): boolean {
    return task.dependencies.every((dependency) => this.require(dependency).status === 'completed');
  }

  private refreshReadiness(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && this.dependenciesCompleted(task)) task.status = 'ready';
    }
  }

  private require(taskId: TaskId): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }
}

export function defaultPlan(goal: string, executionId: string): TaskGraph {
  const graph = new TaskGraph();
  const intake = graph.addTask({ title: 'Interpret goal', description: `Convert the goal into structured requirements: ${goal}` }, executionId);
  const architecture = graph.addTask({ title: 'Assess architecture', description: 'Identify constraints, risks, and evidence needed.', dependencies: [intake.id] }, executionId);
  const execution = graph.addTask({ title: 'Execute bounded work', description: 'Perform the requested work through approved capabilities.', dependencies: [architecture.id] }, executionId);
  graph.addTask({ title: 'Evaluate result', description: 'Validate the result and record structured evidence.', dependencies: [execution.id] }, executionId);
  return graph;
}