import type { FederationNodeHeartbeat, FederationResult, FederationTask } from './state.js';
import { DurableFederationState } from './state.js';
import { FederationRouter } from './router.js';

export interface FederationTaskDispatcher {
  dispatchTask(input: { endpoint: string; task: FederationTask }): Promise<FederationResult>;
}

export interface DistributedRuntimeCoordinatorOptions {
  state: DurableFederationState;
  client: FederationTaskDispatcher;
  router?: FederationRouter;
  leaseMs?: number;
  heartbeatTimeoutMs?: number;
  maxAttempts?: number;
}

export interface DistributedTaskInput {
  executionId: string;
  taskType: string;
  goal: string;
  requiredCapabilities: string[];
  payload: Record<string, unknown>;
}

export interface DistributedRecoveryResult {
  recoveredLeases: Awaited<ReturnType<DurableFederationState['recoverExpiredLeases']>>;
  results: FederationResult[];
}

export class DistributedRuntimeCoordinator {
  private readonly state: DurableFederationState;
  private readonly client: FederationTaskDispatcher;
  private readonly router: FederationRouter;
  private readonly leaseMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: DistributedRuntimeCoordinatorOptions) {
    const leaseMs = options.leaseMs ?? 30_000;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Distributed runtime leaseMs must be greater than zero');
    if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) throw new Error('Distributed runtime heartbeatTimeoutMs must be greater than zero');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Distributed runtime maxAttempts must be a positive integer');
    this.state = options.state;
    this.client = options.client;
    this.router = options.router ?? new FederationRouter();
    this.leaseMs = leaseMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxAttempts = maxAttempts;
  }

  async submit(input: DistributedTaskInput): Promise<FederationTask> {
    await this.state.init();
    if (!input.executionId.trim() || !input.taskType.trim() || !input.goal.trim()) throw new Error('Distributed task identifiers and goal are required');
    if (!Array.isArray(input.requiredCapabilities) || input.requiredCapabilities.some((capability) => !capability.trim())) {
      throw new Error('Distributed task capabilities must be non-empty strings');
    }
    return this.state.enqueueTask({
      executionId: input.executionId,
      taskType: input.taskType,
      goal: input.goal,
      requiredCapabilities: [...new Set(input.requiredCapabilities)],
      payload: structuredClone(input.payload),
    });
  }

  async heartbeatNode(node: FederationNodeHeartbeat, now = Date.now()) {
    await this.state.init();
    return this.state.heartbeatNode(node, now);
  }

  async runTask(taskId: string, now?: number): Promise<FederationResult> {
    await this.state.init();
    const at = now ?? Date.now();
    await this.state.expireStaleNodes(this.heartbeatTimeoutMs, at);
    await this.state.recoverExpiredLeases(at);

    const task = await this.state.getTask(taskId);
    if (!task) throw new Error(`Unknown federation task: ${taskId}`);
    if (task.status === 'completed' || task.status === 'failed') {
      const existing = await this.state.findResultForTask(task.id);
      if (!existing) throw new Error(`Federation task ${task.id} is terminal without a durable result`);
      return existing;
    }
    if (task.status === 'cancelled') throw new Error(`Federation task ${task.id} is cancelled`);
    if (task.status === 'running') throw new Error(`Federation task ${task.id} is already leased`);
    if (task.attempt >= this.maxAttempts) throw new Error(`Federation task ${task.id} reached max attempts (${this.maxAttempts})`);

    const node = this.router.select(await this.state.listNodes(), task.requiredCapabilities, at);
    if (!node) throw new Error(`No healthy federation node can run task ${task.id}`);

    const lease = await this.state.acquireLease(task.id, node.id, { leaseMs: this.leaseMs, now: at });
    const leasedTask = await this.state.getTask(task.id);
    if (!leasedTask || leasedTask.leaseId !== lease.id || leasedTask.assignedNodeId !== node.id) {
      throw new Error(`Federation task ${task.id} lease state was not persisted`);
    }

    let stopRenewal = false;
    let renewalError: unknown;
    const renewal = now === undefined
      ? this.renewLeaseUntilStopped(lease.id, node.id, () => stopRenewal).catch((error) => { renewalError = error; })
      : Promise.resolve();

    let result: FederationResult | undefined;
    let dispatchError: unknown;
    try {
      result = await this.client.dispatchTask({ endpoint: node.endpoint, task: leasedTask });
    } catch (error) {
      dispatchError = error;
    } finally {
      stopRenewal = true;
      await renewal;
    }

    if (dispatchError !== undefined) throw dispatchError;
    if (!result) throw new Error(`Federation task ${task.id} returned no result`);

    const alreadyCommitted = await this.state.getResult(result.id);
    if (alreadyCommitted) return alreadyCommitted;
    if (renewalError !== undefined) throw renewalError;
    return this.state.commitLeasedResult(result, now ?? Date.now());
  }

  async runPending(now?: number): Promise<FederationResult[]> {
    await this.state.init();
    const queued = (await this.state.listTasks())
      .filter((task) => task.status === 'queued')
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
    const results: FederationResult[] = [];
    for (const task of queued) results.push(await this.runTask(task.id, now));
    return results;
  }

  async recover(now?: number): Promise<DistributedRecoveryResult> {
    await this.state.init();
    const at = now ?? Date.now();
    await this.state.expireStaleNodes(this.heartbeatTimeoutMs, at);
    const recoveredLeases = await this.state.recoverExpiredLeases(at);
    const results = await this.runPending(now);
    return { recoveredLeases, results };
  }

  private async renewLeaseUntilStopped(leaseId: string, nodeId: string, shouldStop: () => boolean): Promise<void> {
    const intervalMs = Math.max(1, Math.floor(this.leaseMs / 3));
    while (!shouldStop()) {
      await delay(intervalMs);
      if (shouldStop()) return;
      await this.state.heartbeatLease(leaseId, nodeId, { leaseMs: this.leaseMs });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
