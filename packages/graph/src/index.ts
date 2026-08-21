export type TaskId = string;

export interface TaskContext<T = unknown> {
  taskId: TaskId;
  input: T;
  signal: AbortSignal;
  attempt: number;
}

export interface TaskDefinition<T = unknown, R = unknown> {
  id: TaskId;
  dependsOn?: TaskId[];
  run: (context: TaskContext<T>) => Promise<R> | R;
  retries?: number;
  timeoutMs?: number;
}

export interface TaskResult<R = unknown> {
  taskId: TaskId;
  status: 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  value?: R;
  error?: Error;
  startedAt: string;
  finishedAt: string;
}

export interface GraphExecutionOptions {
  concurrency?: number;
  signal?: AbortSignal;
  input?: unknown;
}

export interface GraphExecutionResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  results: ReadonlyMap<TaskId, TaskResult>;
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export function validateGraph(tasks: readonly TaskDefinition[]): void {
  const ids = new Set<TaskId>();
  for (const task of tasks) {
    if (!task.id || ids.has(task.id)) throw new GraphValidationError(`Duplicate or empty task id: ${task.id}`);
    if (task.retries !== undefined && (!Number.isInteger(task.retries) || task.retries < 0)) {
      throw new GraphValidationError(`Invalid retries for task ${task.id}`);
    }
    if (task.timeoutMs !== undefined && (!Number.isFinite(task.timeoutMs) || task.timeoutMs <= 0)) {
      throw new GraphValidationError(`Invalid timeout for task ${task.id}`);
    }
    ids.add(task.id);
  }

  const dependencies = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn ?? [])]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new GraphValidationError(`Unknown dependency ${dependency} for task ${task.id}`);
    }
  }

  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const visit = (id: TaskId): void => {
    if (visiting.has(id)) throw new GraphValidationError(`Cycle detected at task ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export async function executeGraph(
  tasks: readonly TaskDefinition[],
  options: GraphExecutionOptions = {},
): Promise<GraphExecutionResult> {
  validateGraph(tasks);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const externalSignal = options.signal;
  const results = new Map<TaskId, TaskResult>();
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const controllers = new Map<TaskId, AbortController>();

  const cancelPending = (status: 'cancelled' | 'failed'): void => {
    for (const task of pending.values()) {
      const now = new Date().toISOString();
      results.set(task.id, { taskId: task.id, status, attempts: 0, startedAt: now, finishedAt: now });
    }
    pending.clear();
  };

  while (pending.size > 0) {
    if (externalSignal?.aborted) {
      for (const controller of controllers.values()) controller.abort(externalSignal.reason);
      cancelPending('cancelled');
      break;
    }

    const ready = [...pending.values()].filter((task) =>
      (task.dependsOn ?? []).every((dependency) => results.get(dependency)?.status === 'succeeded'),
    );
    const blocked = [...pending.values()].filter((task) =>
      (task.dependsOn ?? []).some((dependency) => {
        const result = results.get(dependency);
        return result?.status === 'failed' || result?.status === 'cancelled';
      }),
    );

    for (const task of blocked) {
      const now = new Date().toISOString();
      results.set(task.id, { taskId: task.id, status: 'cancelled', attempts: 0, startedAt: now, finishedAt: now });
      pending.delete(task.id);
    }

    if (ready.length === 0) {
      if (pending.size > 0) throw new GraphValidationError('Graph cannot make progress');
      break;
    }

    const batch = ready.slice(0, concurrency);
    for (const task of batch) pending.delete(task.id);
    const batchResults = await Promise.all(batch.map((task) => runTask(task, options.input, externalSignal, controllers)));
    for (const result of batchResults) results.set(result.taskId, result);
  }

  const status = [...results.values()].some((result) => result.status === 'failed')
    ? 'failed'
    : [...results.values()].some((result) => result.status === 'cancelled')
      ? 'cancelled'
      : 'succeeded';
  return { status, results };
}

async function runTask(
  task: TaskDefinition,
  input: unknown,
  externalSignal: AbortSignal | undefined,
  controllers: Map<TaskId, AbortController>,
): Promise<TaskResult> {
  const startedAt = new Date().toISOString();
  let attempts = 0;
  const maxAttempts = (task.retries ?? 0) + 1;
  let lastError: Error | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    if (externalSignal?.aborted) {
      return { taskId: task.id, status: 'cancelled', attempts, startedAt, finishedAt: new Date().toISOString() };
    }
    const controller = new AbortController();
    controllers.set(task.id, controller);
    const abortExternal = (): void => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abortExternal, { once: true });
    try {
      const value = await withTimeout(task.run({ taskId: task.id, input, signal: controller.signal, attempt: attempts }), task.timeoutMs, controller);
      return { taskId: task.id, status: 'succeeded', attempts, value, startedAt, finishedAt: new Date().toISOString() };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (externalSignal?.aborted) {
        return { taskId: task.id, status: 'cancelled', attempts, error: lastError, startedAt, finishedAt: new Date().toISOString() };
      }
    } finally {
      externalSignal?.removeEventListener('abort', abortExternal);
      controllers.delete(task.id);
    }
  }
  return { taskId: task.id, status: 'failed', attempts, error: lastError, startedAt, finishedAt: new Date().toISOString() };
}

async function withTimeout<T>(promise: Promise<T> | T, timeoutMs: number | undefined, controller: AbortController): Promise<T> {
  if (timeoutMs === undefined) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error(`Task timed out after ${timeoutMs}ms`));
      reject(new Error(`Task timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
