import { TaskId, TaskRecord, TaskStatus, id } from '../../core/src/index.js';

export interface TaskSpec {
  title: string;
  description: string;
  dependencies?: TaskId[];
  estimatedMs?: number;
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
