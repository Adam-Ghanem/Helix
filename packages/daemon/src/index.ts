import { mkdir, open, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourceBudget } from '../../core/src/index.js';
import { HelixRuntime, type ModelProvider } from '../../runtime/src/index.js';
import { LeaseScheduler } from '../../scheduler/src/index.js';
import { DurableTaskQueue, WorkerPool, type WorkerTask } from '../../workers/src/index.js';

export interface ExecutionJobInput {
  goal: string;
  budget?: Partial<ResourceBudget>;
}

export interface HelixDaemonOptions {
  dataDirectory: string;
  provider?: ModelProvider;
  concurrency?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  statusIntervalMs?: number;
}

export interface DaemonState {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  dataDirectory: string;
  concurrency: number;
  pool: Awaited<ReturnType<WorkerPool['snapshot']>>;
}

export interface DaemonStatus extends DaemonState {
  running: boolean;
  heartbeatAgeMs: number;
}

export function daemonPaths(dataDirectory: string) {
  return {
    pidFile: join(dataDirectory, 'daemon.pid'),
    statusFile: join(dataDirectory, 'daemon.status.json'),
    queueFile: join(dataDirectory, 'worker.tasks.json'),
    leaseFile: join(dataDirectory, 'worker.leases.json'),
  };
}

export class HelixDaemon {
  readonly runtime: HelixRuntime;
  readonly scheduler: LeaseScheduler;
  readonly queue: DurableTaskQueue;
  readonly pool: WorkerPool;
  private readonly concurrency: number;
  private readonly statusIntervalMs: number;
  private readonly paths: ReturnType<typeof daemonPaths>;
  private startedAt = '';
  private statusTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: HelixDaemonOptions) {
    this.paths = daemonPaths(options.dataDirectory);
    this.concurrency = options.concurrency ?? 4;
    this.statusIntervalMs = options.statusIntervalMs ?? 1_000;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    const leaseMs = options.leaseMs ?? Math.max(20_000, heartbeatIntervalMs * 3);
    this.runtime = new HelixRuntime({ dataDirectory: options.dataDirectory, ...(options.provider ? { provider: options.provider } : {}) });
    this.scheduler = new LeaseScheduler({ stateFile: this.paths.leaseFile, maxConcurrency: this.concurrency, leaseMs });
    this.queue = new DurableTaskQueue({ stateFile: this.paths.queueFile });
    this.pool = new WorkerPool({
      queue: this.queue,
      scheduler: this.scheduler,
      concurrency: this.concurrency,
      ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
      heartbeatIntervalMs,
      workerPrefix: `helix-${process.pid}`,
    });
    this.pool.register('execution', async (task) => this.executeJob(task));
  }

  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(this.options.dataDirectory, { recursive: true });
    await this.acquireSingleton();
    try {
      await this.runtime.init();
      await this.queue.init();
      await this.queue.recoverOrphans(this.scheduler);
      this.startedAt = new Date().toISOString();
      this.running = true;
      this.pool.start();
      await this.writeStatus();
      this.statusTimer = setInterval(() => { void this.writeStatus().catch(() => undefined); }, this.statusIntervalMs);
    } catch (error) {
      this.running = false;
      await this.releaseSingleton();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.running) {
      await this.releaseSingleton();
      return;
    }
    this.running = false;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    await this.pool.stop();
    await this.releaseSingleton();
  }

  async status(): Promise<DaemonState> {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      heartbeatAt: new Date().toISOString(),
      dataDirectory: this.options.dataDirectory,
      concurrency: this.concurrency,
      pool: await this.pool.snapshot(),
    };
  }

  private async executeJob(task: WorkerTask): Promise<unknown> {
    if (!isExecutionJobInput(task.input)) throw new Error(`Invalid execution job payload for ${task.id}`);
    return this.runtime.execute({ goal: task.input.goal, ...(task.input.budget ? { budget: task.input.budget } : {}) });
  }

  private async writeStatus(): Promise<void> {
    if (!this.running) return;
    const state = await this.status();
    const temporary = `${this.paths.statusFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, this.paths.statusFile);
  }

  private async acquireSingleton(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.paths.pidFile, 'wx');
        try {
          await handle.writeFile(String(process.pid), 'utf8');
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existingPid = await readPid(this.paths.pidFile);
        if (existingPid && isProcessAlive(existingPid)) throw new Error(`Helix daemon is already running with PID ${existingPid}`);
        await rm(this.paths.pidFile, { force: true });
        await rm(this.paths.statusFile, { force: true });
      }
    }
    throw new Error('Unable to acquire Helix daemon PID file');
  }

  private async releaseSingleton(): Promise<void> {
    const existingPid = await readPid(this.paths.pidFile);
    if (!existingPid || existingPid === process.pid) await rm(this.paths.pidFile, { force: true });
    await rm(this.paths.statusFile, { force: true });
  }
}

export async function enqueueExecution(dataDirectory: string, input: ExecutionJobInput, options: { maxAttempts?: number; delayMs?: number } = {}) {
  if (!input.goal.trim()) throw new Error('Background execution goal is required');
  const queue = new DurableTaskQueue({ stateFile: daemonPaths(dataDirectory).queueFile });
  await queue.init();
  return queue.enqueue('execution', { goal: input.goal, ...(input.budget ? { budget: input.budget } : {}) }, options);
}

export async function readDaemonStatus(dataDirectory: string): Promise<DaemonStatus | undefined> {
  const paths = daemonPaths(dataDirectory);
  try {
    const state = JSON.parse(await readFile(paths.statusFile, 'utf8')) as DaemonState;
    const heartbeatAgeMs = Math.max(0, Date.now() - Date.parse(state.heartbeatAt));
    return { ...state, running: isProcessAlive(state.pid), heartbeatAgeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const pid = await readPid(paths.pidFile);
    if (!pid) return undefined;
    return {
      pid,
      startedAt: '',
      heartbeatAt: '',
      dataDirectory,
      concurrency: 0,
      pool: { running: false, workers: [], queue: { total: 0, queued: 0, running: 0, completed: 0, failed: 0 } },
      running: isProcessAlive(pid),
      heartbeatAgeMs: Number.POSITIVE_INFINITY,
    };
  }
}

export async function requestDaemonStop(dataDirectory: string): Promise<boolean> {
  const pid = await readPid(daemonPaths(dataDirectory).pidFile);
  if (!pid || !isProcessAlive(pid)) return false;
  process.kill(pid, 'SIGTERM');
  return true;
}

function isExecutionJobInput(value: unknown): value is ExecutionJobInput {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { goal?: unknown; budget?: unknown };
  return typeof candidate.goal === 'string' && candidate.goal.trim().length > 0 && (candidate.budget === undefined || (typeof candidate.budget === 'object' && candidate.budget !== null));
}

async function readPid(pidFile: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(pidFile, 'utf8')).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
