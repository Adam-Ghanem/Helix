import type { TaskId } from '../../core/src/index.js';
import { taskPriorityScore, type SchedulerTask } from './task.js';

export class PriorityTaskQueue {
  private readonly tasks = new Map<TaskId, SchedulerTask>();

  enqueue(task: SchedulerTask): void {
    if (this.tasks.has(task.id)) throw new Error(`Task already queued: ${task.id}`);
    if (task.status === 'cancelled' || task.status === 'completed') return;
    this.tasks.set(task.id, structuredClone(task));
  }

  peek(): SchedulerTask | undefined {
    return this.sorted()[0];
  }

  dequeue(predicate?: (task: SchedulerTask) => boolean): SchedulerTask | undefined {
    const candidate = this.sorted().find((task) => predicate?.(task) ?? true);
    if (!candidate) return undefined;
    this.tasks.delete(candidate.id);
    return candidate;
  }

  cancel(taskId: TaskId): SchedulerTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    this.tasks.delete(taskId);
    task.status = 'cancelled';
    return structuredClone(task);
  }

  has(taskId: TaskId): boolean {
    return this.tasks.has(taskId);
  }

  size(): number {
    return this.tasks.size;
  }

  list(): SchedulerTask[] {
    return this.sorted();
  }

  private sorted(): SchedulerTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => taskPriorityScore(b) - taskPriorityScore(a) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((task) => structuredClone(task));
  }
}
