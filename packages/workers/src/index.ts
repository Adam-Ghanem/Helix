import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { id, timestamp } from '../../core/src/index.js';
import { LeaseScheduler } from '../../scheduler/src/index.js';

export type WorkerTaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface WorkerTask {
  id: string;
  type: string;
  input: unknown;
  status: WorkerTaskStatus;
  createdAt: string;
  updatedAt: string;
  availableAt: number;
  attempts: number;
  maxAttempts: number;
  workerId?: string;
  leaseId?: string;
  heartbeatAt?: string;
  result?: unknown;
  error?: string;
}

export interface QueueStats {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export interface DurableTaskQueueOptions {
  stateFile: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  delayMs?: number;
}

export class DurableTaskQueue {
  private readonly lockDirectory: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private tasks = new Map<string, WorkerTask>();
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly options: DurableTaskQueueOptions) {
    this.lockDirectory = `${options.stateFile}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    await this.reloadFromDisk();
    this.initialized = true;
  }

  async enqueue(type: string, input: unknown, options: EnqueueOptions = {}): Promise<WorkerTask> {
    if (!type.trim()) throw new Error('Worker task type is required');
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
    const delayMs = options.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be zero or greater');
    return this.mutate(async () => {
      const now = Date.now();
      const task: WorkerTask = {
        id: id('job'),
        type,
        input,
        status: 'queued',
        createdAt: timestamp(),
        updatedAt: timestamp(),
        availableAt: now + delayMs,
        attempts: 0,
        maxAttempts,
      };
      this.tasks.set(task.id, task);
      await this.persist();
      return structuredClone(task);
    });
  }

  async get(taskId: string): Promise<WorkerTask> {
    await this.init();
    await this.reloadFromDisk();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown worker task: ${taskId}`);
    return structuredClone(task);
  }

  async list(status?: WorkerTaskStatus): Promise<WorkerTask[]> {
    await this.init();
    await this.reloadFromDisk();
    return [...this.tasks.values()]
      .filter((task) => !status || task.status === status)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map((task) => structuredClone(task));
  }

  async stats(): Promise<QueueStats> {
    const tasks = await this.list();
    return {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      running: tasks.filter((task) => task.status === 'running').length,
      completed: tasks.filter((task) => task.status === 'completed').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
    };
  }

  async claim(workerId: string, scheduler: LeaseScheduler, acceptedTypes?: string[]): Promise<WorkerTask | undefined> {
    return this.mutate(async () => {
      this.reconcileRunningTasks(scheduler);
      const now = Date.now();
      const candidates = [...this.tasks.values()]
        .filter((task) => task.status === 'queued' && task.availableAt <= now && task.attempts < task.maxAttempts)
        .filter((task) => !acceptedTypes?.length || acceptedTypes.includes(task.type))
        .sort((left, right) => left.availableAt - right.availableAt || Date.parse(left.createdAt) - Date.parse(right.createdAt));

      for (const task of candidates) {
        const lease = scheduler.acquire(task.id, workerId);
        if (!lease) return undefined;
        task.status = 'running';
        task.workerId = workerId;
        task.leaseId = lease.id;
        task.heartbeatAt = timestamp();
        task.attempts += 1;
        task.updatedAt = timestamp();
        delete task.error;
        await this.persist();
        return structuredClone(task);
      }
      return undefined;
    });
  }

  async heartbeat(taskId: string, workerId: string, scheduler: LeaseScheduler): Promise<WorkerTask> {
    return this.mutate(async () => {
      const task = this.requireRunning(taskId, workerId);
      if (!task.leaseId) throw new Error(`Worker task ${taskId} has no active lease`);
      scheduler.heartbeat(task.leaseId);
      task.heartbeatAt = timestamp();
      task.updatedAt = timestamp();
      await this.persist();
      return structuredClone(task);
    });
  }

  async complete(taskId: string, workerId: string, scheduler: LeaseScheduler, result: unknown): Promise<WorkerTask> {
    return this.mutate(async () => {
      const task = this.requireRunning(taskId, workerId);
      if (!task.leaseId) throw new Error(`Worker task ${taskId} has no active lease`);
      const activeLease = scheduler.list().some((lease) => lease.id === task.leaseId && lease.workerId === workerId);
      if (!activeLease) throw new Error(`Worker task ${taskId} lost its lease before completion`);
      scheduler.release(task.leaseId);
      task.status = 'completed';
      task.result = result;
      task.updatedAt = timestamp();
      delete task.workerId;
      delete task.leaseId;
      delete task.heartbeatAt;
      delete task.error;
      await this.persist();
      return structuredClone(task);
    });
  }

  async fail(taskId: string, workerId: string, scheduler: LeaseScheduler, error: unknown, retryDelayMs = 0): Promise<WorkerTask> {
    return this.mutate(async () => {
      const task = this.requireRunning(taskId, workerId);
      if (task.leaseId && scheduler.list().some((lease) => lease.id === task.leaseId)) scheduler.release(task.leaseId);
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = timestamp();
      delete task.workerId;
      delete task.leaseId;
      delete task.heartbeatAt;
      if (task.attempts < task.maxAttempts) {
        task.status = 'queued';
        task.availableAt = Date.now() + Math.max(0, retryDelayMs);
      } else {
        task.status = 'failed';
      }
      await this.persist();
      return structuredClone(task);
    });
  }

  async recoverOrphans(scheduler: LeaseScheduler): Promise<WorkerTask[]> {
    return this.mutate(async () => {
      const recovered = this.reconcileRunningTasks(scheduler);
      if (recovered.length) await this.persist();
      return recovered.map((task) => structuredClone(task));
    });
  }

  private reconcileRunningTasks(scheduler: LeaseScheduler): WorkerTask[] {
    scheduler.recoverExpired();
    const activeLeaseIds = new Set(scheduler.list().map((lease) => lease.id));
    const recovered: WorkerTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      if (task.leaseId && activeLeaseIds.has(task.leaseId)) continue;
      delete task.workerId;
      delete task.leaseId;
      delete task.heartbeatAt;
      task.updatedAt = timestamp();
      if (task.attempts < task.maxAttempts) {
        task.status = 'queued';
        task.availableAt = Date.now();
        task.error = 'Recovered abandoned worker lease';
      } else {
        task.status = 'failed';
        task.error = task.error ?? 'Worker lease expired after maximum attempts';
      }
      recovered.push(task);
    }
    return recovered;
  }

  private requireRunning(taskId: string, workerId: string): WorkerTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown worker task: ${taskId}`);
    if (task.status !== 'running' || task.workerId !== workerId) throw new Error(`Worker ${workerId} does not own task ${taskId}`);
    return task;
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      const persisted = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as WorkerTask[];
      this.tasks = new Map(persisted.map((task) => [task.id, task]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.tasks = new Map();
    }
  }

  private async persist(): Promise<void> {
    const temporary = `${this.options.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.tasks.values()], null, 2), 'utf8');
    await rename(temporary, this.options.stateFile);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.init();
    return this.enqueueMutation(async () => this.withFileLock(async () => {
      await this.reloadFromDisk();
      return operation();
    }));
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    while (true) {
      try {
        await mkdir(this.lockDirectory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const age = Date.now() - (await stat(this.lockDirectory)).mtimeMs;
          if (age > this.staleLockMs) await rm(this.lockDirectory, { recursive: true, force: true });
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        if (Date.now() - started > this.lockTimeoutMs) throw new Error('Timed out acquiring worker queue lock');
        await sleep(5);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(this.lockDirectory, { recursive: true, force: true });
    }
  }
}

export interface WorkerContext {
  workerId: string;
  heartbeat(): Promise<void>;
}

export type WorkerHandler = (task: WorkerTask, context: WorkerContext) => Promise<unknown>;

export interface WorkerPoolOptions {
  queue: DurableTaskQueue;
  scheduler: LeaseScheduler;
  concurrency?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  workerPrefix?: string;
  retryDelayMs?: number;
}

export interface WorkerState {
  id: string;
  status: 'idle' | 'busy' | 'stopped';
  heartbeatAt: string;
  currentTaskId?: string;
}

export class WorkerPool {
  private readonly handlers = new Map<string, WorkerHandler>();
  private readonly workers = new Map<string, WorkerState>();
  private readonly loops: Promise<void>[] = [];
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly workerPrefix: string;
  private readonly retryDelayMs: number;
  private running = false;

  constructor(private readonly options: WorkerPoolOptions) {
    this.concurrency = options.concurrency ?? 4;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.workerPrefix = options.workerPrefix ?? `worker-${process.pid}`;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) throw new Error('Worker concurrency must be a positive integer');
  }

  register(type: string, handler: WorkerHandler): void {
    if (!type.trim()) throw new Error('Worker handler type is required');
    if (this.handlers.has(type)) throw new Error(`Worker handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }

  start(): void {
    if (this.running) return;
    if (!this.handlers.size) throw new Error('Worker pool requires at least one registered handler');
    this.running = true;
    for (let index = 0; index < this.concurrency; index += 1) {
      const workerId = `${this.workerPrefix}-${index + 1}`;
      this.workers.set(workerId, { id: workerId, status: 'idle', heartbeatAt: timestamp() });
      this.loops.push(this.runLoop(workerId));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
    for (const worker of this.workers.values()) {
      worker.status = 'stopped';
      worker.heartbeatAt = timestamp();
      delete worker.currentTaskId;
    }
  }

  listWorkers(): WorkerState[] {
    return [...this.workers.values()].map((worker) => structuredClone(worker));
  }

  async snapshot(): Promise<{ running: boolean; workers: WorkerState[]; queue: QueueStats }> {
    return { running: this.running, workers: this.listWorkers(), queue: await this.options.queue.stats() };
  }

  private async runLoop(workerId: string): Promise<void> {
    while (this.running) {
      await this.options.queue.recoverOrphans(this.options.scheduler);
      const task = await this.options.queue.claim(workerId, this.options.scheduler, [...this.handlers.keys()]);
      if (!task) {
        this.touch(workerId, 'idle');
        await sleep(this.pollIntervalMs);
        continue;
      }

      const handler = this.handlers.get(task.type);
      if (!handler) {
        await this.options.queue.fail(task.id, workerId, this.options.scheduler, `No handler registered for ${task.type}`, this.retryDelayMs);
        continue;
      }

      this.touch(workerId, 'busy', task.id);
      let leaseLost = false;
      const heartbeat = async (): Promise<void> => {
        try {
          await this.options.queue.heartbeat(task.id, workerId, this.options.scheduler);
          this.touch(workerId, 'busy', task.id);
        } catch {
          leaseLost = true;
          throw new Error(`Worker ${workerId} lost lease for ${task.id}`);
        }
      };
      const timer = setInterval(() => { void heartbeat().catch(() => undefined); }, this.heartbeatIntervalMs);

      try {
        const result = await handler(task, { workerId, heartbeat });
        if (leaseLost) {
          await this.options.queue.recoverOrphans(this.options.scheduler);
        } else {
          await this.options.queue.complete(task.id, workerId, this.options.scheduler, result);
        }
      } catch (error) {
        if (leaseLost) await this.options.queue.recoverOrphans(this.options.scheduler);
        else await this.options.queue.fail(task.id, workerId, this.options.scheduler, error, this.retryDelayMs);
      } finally {
        clearInterval(timer);
        this.touch(workerId, 'idle');
      }
    }
  }

  private touch(workerId: string, status: WorkerState['status'], currentTaskId?: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.status = status;
    worker.heartbeatAt = timestamp();
    if (currentTaskId) worker.currentTaskId = currentTaskId;
    else delete worker.currentTaskId;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
