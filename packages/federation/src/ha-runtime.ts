import { FederationRouter } from './router.js';
import type { FederationNodeHeartbeat, FederationResult } from './state.js';
import type { DistributedTaskInput, FederationTaskDispatcher } from './runtime.js';
import type {
  FederationHaStore,
  FederationHaTask,
  FederationLeaderLease,
  LeadershipResult,
} from './ha-store.js';

export interface HighAvailabilityDistributedCoordinatorOptions {
  coordinatorId: string;
  store: FederationHaStore;
  client: FederationTaskDispatcher;
  router?: FederationRouter;
  leaderTtlMs?: number;
  taskLeaseMs?: number;
  heartbeatTimeoutMs?: number;
  maxAttempts?: number;
}

export interface HaRecoveryResult {
  recoveredTasks: FederationHaTask[];
  results: FederationResult[];
}

export class HighAvailabilityDistributedCoordinator {
  private readonly coordinatorId: string;
  private readonly store: FederationHaStore;
  private readonly client: FederationTaskDispatcher;
  private readonly router: FederationRouter;
  private readonly leaderTtlMs: number;
  private readonly taskLeaseMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxAttempts: number;
  private leader: FederationLeaderLease | undefined;
  private initialized = false;

  constructor(options: HighAvailabilityDistributedCoordinatorOptions) {
    if (!options.coordinatorId.trim()) throw new Error('HA coordinatorId is required');
    const leaderTtlMs = options.leaderTtlMs ?? 15_000;
    const taskLeaseMs = options.taskLeaseMs ?? 30_000;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    const maxAttempts = options.maxAttempts ?? 3;
    validatePositive(leaderTtlMs, 'HA leaderTtlMs');
    validatePositive(taskLeaseMs, 'HA taskLeaseMs');
    validatePositive(heartbeatTimeoutMs, 'HA heartbeatTimeoutMs');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('HA maxAttempts must be a positive integer');

    this.coordinatorId = options.coordinatorId;
    this.store = options.store;
    this.client = options.client;
    this.router = options.router ?? new FederationRouter();
    this.leaderTtlMs = leaderTtlMs;
    this.taskLeaseMs = taskLeaseMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxAttempts = maxAttempts;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    this.initialized = true;
  }

  async campaign(now?: number): Promise<LeadershipResult> {
    this.assertInitialized();
    const result = await this.store.acquireLeadership(this.coordinatorId, {
      ttlMs: this.leaderTtlMs,
      ...(now !== undefined ? { now } : {}),
    });
    if (result.acquired && result.lease?.leaderId === this.coordinatorId) this.leader = structuredClone(result.lease);
    else this.leader = undefined;
    return cloneLeadership(result);
  }

  async renewLeadership(now?: number): Promise<FederationLeaderLease> {
    this.assertInitialized();
    const current = this.requireLocalLeadership();
    const renewed = await this.store.renewLeadership(current, {
      ttlMs: this.leaderTtlMs,
      ...(now !== undefined ? { now } : {}),
    });
    this.leader = structuredClone(renewed);
    return structuredClone(renewed);
  }

  leadership(): FederationLeaderLease | undefined {
    return this.leader ? structuredClone(this.leader) : undefined;
  }

  async heartbeatNode(node: FederationNodeHeartbeat, now?: number) {
    this.assertInitialized();
    return this.store.heartbeatNode(node, now);
  }

  async submit(input: DistributedTaskInput, now?: number): Promise<FederationHaTask> {
    const leader = await this.requireLeadership(now);
    return this.store.submitTask(leader, {
      executionId: input.executionId,
      taskType: input.taskType,
      goal: input.goal,
      requiredCapabilities: [...new Set(input.requiredCapabilities)],
      payload: structuredClone(input.payload),
    }, now);
  }

  async runTask(taskId: string, now?: number): Promise<FederationResult> {
    const at = now ?? Date.now();
    const leader = await this.requireLeadership(now);
    await this.store.expireStaleNodes(leader, this.heartbeatTimeoutMs, at);
    await this.store.recoverExpiredTaskLeases(leader, at);

    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Unknown federation task: ${taskId}`);
    if (task.status === 'completed' || task.status === 'failed') {
      const existing = await this.store.findResultForTask(task.id);
      if (!existing) throw new Error(`Federation task ${task.id} is terminal without a durable result`);
      return existing;
    }
    if (task.status === 'cancelled') throw new Error(`Federation task ${task.id} is cancelled`);
    if (task.status === 'running') throw new Error(`Federation task ${task.id} is already leased`);
    if (task.attempt >= this.maxAttempts) throw new Error(`Federation task ${task.id} reached max attempts (${this.maxAttempts})`);

    const node = this.router.select(await this.store.listNodes(), task.requiredCapabilities, at);
    if (!node) throw new Error(`No healthy federation node can run task ${task.id}`);

    const claim = await this.store.claimTask(leader, task.id, node.id, {
      leaseMs: this.taskLeaseMs,
      ...(now !== undefined ? { now } : {}),
    });

    let stopRenewal = false;
    let renewalError: unknown;
    const renewal = now === undefined
      ? this.renewLeasesUntilStopped(claim.leaseId, node.id, () => stopRenewal).catch((error) => { renewalError = error; })
      : Promise.resolve();

    let result: FederationResult | undefined;
    let dispatchError: unknown;
    try {
      result = await this.client.dispatchTask({ endpoint: node.endpoint, task: claim.task });
    } catch (error) {
      dispatchError = error;
    } finally {
      stopRenewal = true;
      await renewal;
    }

    if (dispatchError !== undefined) throw dispatchError;
    if (renewalError !== undefined) throw renewalError;
    if (!result) throw new Error(`Federation task ${task.id} returned no result`);
    if (result.taskId !== claim.task.id || result.executionId !== claim.task.executionId || result.nodeId !== node.id
      || result.leaseId !== claim.leaseId || result.attempt !== claim.task.attempt) {
      throw new Error('Federation result does not match HA task fencing token');
    }

    const currentLeader = await this.requireLeadership(now);
    return this.store.commitResult(currentLeader, result, now ?? Date.now());
  }

  async runPending(now?: number): Promise<FederationResult[]> {
    await this.requireLeadership(now);
    const queued = (await this.store.listTasks())
      .filter((task) => task.status === 'queued')
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
    const results: FederationResult[] = [];
    for (const task of queued) results.push(await this.runTask(task.id, now));
    return results;
  }

  async recover(now?: number): Promise<HaRecoveryResult> {
    const at = now ?? Date.now();
    const leader = await this.requireLeadership(now);
    await this.store.expireStaleNodes(leader, this.heartbeatTimeoutMs, at);
    const recoveredTasks = await this.store.recoverExpiredTaskLeases(leader, at);
    const results = await this.runPending(now);
    return { recoveredTasks, results };
  }

  private async requireLeadership(now?: number): Promise<FederationLeaderLease> {
    this.assertInitialized();
    const leader = this.requireLocalLeadership();
    try {
      await this.store.assertLeadership(leader, now ?? Date.now());
    } catch (error) {
      this.leader = undefined;
      throw error;
    }
    return structuredClone(leader);
  }

  private requireLocalLeadership(): FederationLeaderLease {
    if (!this.leader || this.leader.leaderId !== this.coordinatorId) throw new Error(`HA coordinator ${this.coordinatorId} is not leader`);
    return structuredClone(this.leader);
  }

  private async renewLeasesUntilStopped(taskLeaseId: string, nodeId: string, shouldStop: () => boolean): Promise<void> {
    const intervalMs = Math.max(1, Math.floor(Math.min(this.leaderTtlMs, this.taskLeaseMs) / 3));
    while (!shouldStop()) {
      await delay(intervalMs);
      if (shouldStop()) return;
      const leader = await this.renewLeadership();
      await this.store.renewTaskLease(leader, taskLeaseId, nodeId, { leaseMs: this.taskLeaseMs });
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('HighAvailabilityDistributedCoordinator.init() must be called first');
  }
}

function cloneLeadership(result: LeadershipResult): LeadershipResult {
  return {
    acquired: result.acquired,
    ...(result.lease ? { lease: structuredClone(result.lease) } : {}),
  };
}

function validatePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
