import { randomUUID } from 'node:crypto';
import type { FederationNode } from './index.js';
import type { FederationNodeHeartbeat, FederationResult, FederationTask } from './state.js';

export interface FederationLeaderLease {
  clusterId: string;
  leaderId: string;
  term: number;
  fencingToken: string;
  heartbeatAt: string;
  expiresAt: number;
}

export interface LeadershipResult {
  acquired: boolean;
  lease?: FederationLeaderLease;
}

export interface FederationHaTask extends FederationTask {
  leaderTerm?: number;
  leaderFencingToken?: string;
  leaseExpiresAt?: number;
}

export interface HaTaskClaim {
  task: FederationHaTask;
  leaseId: string;
  leaderTerm: number;
  leaderFencingToken: string;
}

export interface LeadershipOptions {
  ttlMs: number;
  now?: number;
}

export interface HaTaskLeaseOptions {
  leaseMs: number;
  now?: number;
}

export interface FederationHaStore {
  init(): Promise<void>;
  acquireLeadership(coordinatorId: string, options: LeadershipOptions): Promise<LeadershipResult>;
  renewLeadership(lease: FederationLeaderLease, options: LeadershipOptions): Promise<FederationLeaderLease>;
  assertLeadership(lease: FederationLeaderLease, now?: number): Promise<void>;
  submitTask(lease: FederationLeaderLease, input: Omit<FederationTask, 'id' | 'assignedNodeId' | 'leaseId' | 'status' | 'attempt' | 'createdAt' | 'updatedAt' | 'error'>, now?: number): Promise<FederationHaTask>;
  getTask(taskId: string): Promise<FederationHaTask | undefined>;
  listTasks(): Promise<FederationHaTask[]>;
  listNodes(): Promise<FederationNode[]>;
  heartbeatNode(input: FederationNodeHeartbeat, now?: number): Promise<FederationNode>;
  expireStaleNodes(lease: FederationLeaderLease, timeoutMs: number, now?: number): Promise<FederationNode[]>;
  claimTask(lease: FederationLeaderLease, taskId: string, nodeId: string, options: HaTaskLeaseOptions): Promise<HaTaskClaim>;
  renewTaskLease(lease: FederationLeaderLease, leaseId: string, nodeId: string, options: HaTaskLeaseOptions): Promise<HaTaskClaim>;
  recoverExpiredTaskLeases(lease: FederationLeaderLease, now?: number): Promise<FederationHaTask[]>;
  commitResult(lease: FederationLeaderLease, result: FederationResult, now?: number): Promise<FederationResult>;
  findResultForTask(taskId: string, attempt?: number): Promise<FederationResult | undefined>;
}

export interface MemoryFederationHaStoreOptions {
  clusterId: string;
}

export class MemoryFederationHaStore implements FederationHaStore {
  private readonly clusterId: string;
  private leader?: FederationLeaderLease;
  private readonly nodes = new Map<string, FederationNode>();
  private readonly tasks = new Map<string, FederationHaTask>();
  private readonly results = new Map<string, FederationResult>();
  private initialized = false;
  private mutation = Promise.resolve();

  constructor(options: MemoryFederationHaStoreOptions) {
    if (!options.clusterId.trim()) throw new Error('HA clusterId is required');
    this.clusterId = options.clusterId;
  }

  async init(): Promise<void> {
    this.initialized = true;
  }

  async acquireLeadership(coordinatorId: string, options: LeadershipOptions): Promise<LeadershipResult> {
    return this.serial(async () => {
      this.assertInitialized();
      validateTtl(options.ttlMs);
      if (!coordinatorId.trim()) throw new Error('Coordinator id is required');
      const now = options.now ?? Date.now();
      if (!this.leader) {
        this.leader = createLeader(this.clusterId, coordinatorId, 1, options.ttlMs, now);
        return { acquired: true, lease: clone(this.leader) };
      }
      if (this.leader.leaderId === coordinatorId && this.leader.expiresAt > now) {
        this.leader.heartbeatAt = new Date(now).toISOString();
        this.leader.expiresAt = now + options.ttlMs;
        return { acquired: true, lease: clone(this.leader) };
      }
      if (this.leader.expiresAt > now) return { acquired: false, lease: clone(this.leader) };
      this.leader = createLeader(this.clusterId, coordinatorId, this.leader.term + 1, options.ttlMs, now);
      return { acquired: true, lease: clone(this.leader) };
    });
  }

  async renewLeadership(lease: FederationLeaderLease, options: LeadershipOptions): Promise<FederationLeaderLease> {
    return this.serial(async () => {
      this.assertInitialized();
      validateTtl(options.ttlMs);
      const now = options.now ?? Date.now();
      this.assertLeaderUnsafe(lease, now);
      this.leader!.heartbeatAt = new Date(now).toISOString();
      this.leader!.expiresAt = now + options.ttlMs;
      return clone(this.leader!);
    });
  }

  async assertLeadership(lease: FederationLeaderLease, now = Date.now()): Promise<void> {
    this.assertInitialized();
    this.assertLeaderUnsafe(lease, now);
  }

  async submitTask(
    lease: FederationLeaderLease,
    input: Omit<FederationTask, 'id' | 'assignedNodeId' | 'leaseId' | 'status' | 'attempt' | 'createdAt' | 'updatedAt' | 'error'>,
    now = Date.now(),
  ): Promise<FederationHaTask> {
    return this.serial(async () => {
      this.assertLeaderUnsafe(lease, now);
      const at = new Date(now).toISOString();
      const task: FederationHaTask = {
        ...clone(input),
        id: `fedt_${randomUUID()}`,
        requiredCapabilities: [...new Set(input.requiredCapabilities)],
        status: 'queued',
        attempt: 0,
        createdAt: at,
        updatedAt: at,
      };
      this.tasks.set(task.id, task);
      return clone(task);
    });
  }

  async getTask(taskId: string): Promise<FederationHaTask | undefined> {
    this.assertInitialized();
    const task = this.tasks.get(taskId);
    return task ? clone(task) : undefined;
  }

  async listTasks(): Promise<FederationHaTask[]> {
    this.assertInitialized();
    return [...this.tasks.values()].map(clone);
  }

  async listNodes(): Promise<FederationNode[]> {
    this.assertInitialized();
    return [...this.nodes.values()].map(clone);
  }

  async heartbeatNode(input: FederationNodeHeartbeat, now = Date.now()): Promise<FederationNode> {
    return this.serial(async () => {
      this.assertInitialized();
      if (!input.id.trim() || !/^https?:\/\//.test(input.endpoint)) throw new Error('Invalid federation heartbeat node');
      if (!Array.isArray(input.capabilities) || input.capabilities.some((value) => !value.trim())) throw new Error('Invalid federation capabilities');
      const existing = this.nodes.get(input.id);
      const node: FederationNode = {
        id: input.id,
        endpoint: input.endpoint,
        capabilities: [...new Set(input.capabilities)],
        status: existing?.status === 'quarantined' ? 'quarantined' : 'online',
        lastHeartbeat: new Date(now).toISOString(),
        load: normalizeLoad(input.load),
      };
      this.nodes.set(node.id, node);
      return clone(node);
    });
  }

  async expireStaleNodes(lease: FederationLeaderLease, timeoutMs: number, now = Date.now()): Promise<FederationNode[]> {
    return this.serial(async () => {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Heartbeat timeout must be greater than zero');
      this.assertLeaderUnsafe(lease, now);
      const expired: FederationNode[] = [];
      for (const node of this.nodes.values()) {
        if (node.status !== 'online') continue;
        const heartbeat = node.lastHeartbeat ? Date.parse(node.lastHeartbeat) : Number.NaN;
        if (Number.isFinite(heartbeat) && now - heartbeat <= timeoutMs) continue;
        node.status = 'offline';
        expired.push(clone(node));
      }
      return expired;
    });
  }

  async claimTask(lease: FederationLeaderLease, taskId: string, nodeId: string, options: HaTaskLeaseOptions): Promise<HaTaskClaim> {
    return this.serial(async () => {
      validateTtl(options.leaseMs);
      const now = options.now ?? Date.now();
      this.assertLeaderUnsafe(lease, now);
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown federation task: ${taskId}`);
      if (task.status !== 'queued') throw new Error(`Federation task ${taskId} cannot be claimed while ${task.status}`);
      const node = this.nodes.get(nodeId);
      if (!node || node.status !== 'online') throw new Error(`Federation node ${nodeId} is not online`);
      if (!task.requiredCapabilities.every((capability) => node.capabilities.includes(capability))) throw new Error(`Federation node ${nodeId} lacks required capabilities`);
      const leaseId = `fedl_${randomUUID()}`;
      task.status = 'running';
      task.attempt += 1;
      task.assignedNodeId = nodeId;
      task.leaseId = leaseId;
      task.leaseExpiresAt = now + options.leaseMs;
      task.leaderTerm = lease.term;
      task.leaderFencingToken = lease.fencingToken;
      task.updatedAt = new Date(now).toISOString();
      return { task: clone(task), leaseId, leaderTerm: lease.term, leaderFencingToken: lease.fencingToken };
    });
  }

  async renewTaskLease(lease: FederationLeaderLease, leaseId: string, nodeId: string, options: HaTaskLeaseOptions): Promise<HaTaskClaim> {
    return this.serial(async () => {
      validateTtl(options.leaseMs);
      const now = options.now ?? Date.now();
      this.assertLeaderUnsafe(lease, now);
      const task = [...this.tasks.values()].find((candidate) => candidate.leaseId === leaseId);
      if (!task || task.status !== 'running') throw new Error(`Unknown active federation task lease: ${leaseId}`);
      if (task.assignedNodeId !== nodeId) throw new Error(`Federation task lease ${leaseId} belongs to another node`);
      if ((task.leaseExpiresAt ?? 0) <= now) throw new Error(`Federation task lease ${leaseId} has expired`);
      if (task.leaderTerm !== lease.term || task.leaderFencingToken !== lease.fencingToken) throw new Error('Stale leader task lease');
      task.leaseExpiresAt = now + options.leaseMs;
      task.updatedAt = new Date(now).toISOString();
      return { task: clone(task), leaseId, leaderTerm: lease.term, leaderFencingToken: lease.fencingToken };
    });
  }

  async recoverExpiredTaskLeases(lease: FederationLeaderLease, now = Date.now()): Promise<FederationHaTask[]> {
    return this.serial(async () => {
      this.assertLeaderUnsafe(lease, now);
      const recovered: FederationHaTask[] = [];
      for (const task of this.tasks.values()) {
        if (task.status !== 'running' || (task.leaseExpiresAt ?? Number.POSITIVE_INFINITY) > now) continue;
        task.status = 'queued';
        delete task.assignedNodeId;
        delete task.leaseId;
        delete task.leaseExpiresAt;
        delete task.leaderTerm;
        delete task.leaderFencingToken;
        task.updatedAt = new Date(now).toISOString();
        recovered.push(clone(task));
      }
      return recovered;
    });
  }

  async commitResult(lease: FederationLeaderLease, result: FederationResult, now = Date.now()): Promise<FederationResult> {
    return this.serial(async () => {
      this.assertLeaderUnsafe(lease, now);
      const existing = this.results.get(result.id);
      if (existing) return clone(existing);
      const task = this.tasks.get(result.taskId);
      if (!task) throw new Error(`Unknown federation task: ${result.taskId}`);
      if (task.status !== 'running' || !task.leaseId || task.leaseId !== result.leaseId || task.assignedNodeId !== result.nodeId || task.attempt !== result.attempt) {
        throw new Error('Stale federation result: worker lease fencing mismatch');
      }
      if ((task.leaseExpiresAt ?? 0) <= now) throw new Error('Stale federation result: worker lease expired');
      if (task.leaderTerm !== lease.term || task.leaderFencingToken !== lease.fencingToken) throw new Error('Stale leader result commit');
      const committed = clone(result);
      this.results.set(committed.id, committed);
      task.status = committed.success ? 'completed' : 'failed';
      delete task.leaseId;
      delete task.leaseExpiresAt;
      delete task.leaderTerm;
      delete task.leaderFencingToken;
      if (committed.success) delete task.error;
      else task.error = committed.error ?? 'Federation task failed';
      task.updatedAt = new Date(now).toISOString();
      return clone(committed);
    });
  }

  async findResultForTask(taskId: string, attempt?: number): Promise<FederationResult | undefined> {
    this.assertInitialized();
    const matches = [...this.results.values()].filter((result) => result.taskId === taskId && (attempt === undefined || result.attempt === attempt));
    matches.sort((a, b) => b.attempt - a.attempt || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return matches[0] ? clone(matches[0]) : undefined;
  }

  private assertLeaderUnsafe(lease: FederationLeaderLease, now: number): void {
    this.assertInitialized();
    const current = this.leader;
    if (!current || current.clusterId !== lease.clusterId || current.leaderId !== lease.leaderId || current.term !== lease.term || current.fencingToken !== lease.fencingToken || current.expiresAt <= now) {
      throw new Error('Stale leader lease');
    }
  }

  private async serial<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('MemoryFederationHaStore.init() must be called first');
  }
}

function createLeader(clusterId: string, leaderId: string, term: number, ttlMs: number, now: number): FederationLeaderLease {
  return {
    clusterId,
    leaderId,
    term,
    fencingToken: randomUUID(),
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  };
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Lease ttl must be greater than zero');
}

function normalizeLoad(load: number | undefined): number {
  if (load === undefined) return 0;
  if (!Number.isFinite(load) || load < 0) throw new Error('Federation node load must be a non-negative number');
  return load;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
