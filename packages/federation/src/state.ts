import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FederationMessage, FederationNode } from './index.js';

export type FederationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface FederationTask {
  id: string;
  executionId: string;
  taskType: string;
  goal: string;
  requiredCapabilities: string[];
  payload: Record<string, unknown>;
  assignedNodeId?: string;
  leaseId?: string;
  status: FederationTaskStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface FederationLease {
  id: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: number;
}

export interface FederationResult {
  id: string;
  taskId: string;
  executionId: string;
  nodeId: string;
  leaseId?: string;
  attempt: number;
  success: boolean;
  output?: unknown;
  error?: string;
  createdAt: string;
}

export interface FederationMessageAcceptance {
  accepted: boolean;
  reason: 'accepted' | 'replay' | 'expired' | 'wrong-recipient' | 'invalid-signature';
}

interface SeenMessage {
  id: string;
  nonce: string;
  expiresAt: string;
}

type LegacyFederationResult = Omit<FederationResult, 'attempt'> & { attempt?: number };

interface FederationStateFileV1 {
  version: 1;
  nodes: FederationNode[];
  tasks: FederationTask[];
  results: LegacyFederationResult[];
  seenMessages: SeenMessage[];
}

interface FederationStateFileV2 {
  version: 2;
  nodes: FederationNode[];
  tasks: FederationTask[];
  leases: FederationLease[];
  results: LegacyFederationResult[];
  seenMessages: SeenMessage[];
}

type FederationStateFile = FederationStateFileV1 | FederationStateFileV2;

export interface DurableFederationStateOptions {
  stateFile: string;
  localNodeId: string;
  secret: string;
}

export interface FederationLeaseOptions {
  leaseMs: number;
  now?: number;
}

export class DurableFederationState {
  private readonly stateFile: string;
  private readonly localNodeId: string;
  private readonly secret: string;
  private nodes = new Map<string, FederationNode>();
  private tasks = new Map<string, FederationTask>();
  private leases = new Map<string, FederationLease>();
  private results = new Map<string, FederationResult>();
  private seenById = new Map<string, SeenMessage>();
  private seenByNonce = new Map<string, SeenMessage>();
  private initialized = false;

  constructor(options: DurableFederationStateOptions) {
    if (!options.stateFile) throw new Error('Federation stateFile is required');
    if (!options.localNodeId.trim()) throw new Error('Federation localNodeId is required');
    if (!options.secret) throw new Error('Federation secret is required');
    this.stateFile = options.stateFile;
    this.localNodeId = options.localNodeId;
    this.secret = options.secret;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.stateFile), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as FederationStateFile;
      const hasBaseArrays = Array.isArray(parsed.nodes) && Array.isArray(parsed.tasks) && Array.isArray(parsed.results) && Array.isArray(parsed.seenMessages);
      const validVersion = parsed.version === 1 || (parsed.version === 2 && Array.isArray(parsed.leases));
      if (!hasBaseArrays || !validVersion) throw new Error('Invalid durable federation state');

      this.nodes = new Map(parsed.nodes.map((node) => [node.id, clone(node)]));
      this.tasks = new Map(parsed.tasks.map((task) => [task.id, normalizeTask(task)]));
      const leases = parsed.version === 2 ? parsed.leases : [];
      this.leases = new Map(leases.map((lease) => [lease.id, normalizeLease(lease)]));
      this.results = new Map(parsed.results.map((result) => {
        const normalized = normalizeResult(result, this.tasks.get(result.taskId));
        return [normalized.id, normalized];
      }));
      for (const seen of parsed.seenMessages) {
        this.seenById.set(seen.id, { ...seen });
        this.seenByNonce.set(seen.nonce, { ...seen });
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.persist();
    }
    this.pruneSeen(Date.now());
    this.initialized = true;
  }

  async upsertNode(node: FederationNode): Promise<FederationNode> {
    this.assertInitialized();
    validateNode(node);
    const normalized: FederationNode = {
      ...clone(node),
      capabilities: [...new Set(node.capabilities)],
      load: normalizeLoad(node.load),
    };
    this.nodes.set(node.id, normalized);
    await this.persist();
    return clone(normalized);
  }

  async listNodes(): Promise<FederationNode[]> {
    this.assertInitialized();
    return [...this.nodes.values()].map(clone);
  }

  async acceptMessage<T>(message: FederationMessage<T>, now = Date.now()): Promise<FederationMessageAcceptance> {
    this.assertInitialized();
    if (message.to !== this.localNodeId) return { accepted: false, reason: 'wrong-recipient' };
    if (!Number.isFinite(Date.parse(message.expiresAt)) || Date.parse(message.expiresAt) <= now) return { accepted: false, reason: 'expired' };
    if (!this.signatureValid(message)) return { accepted: false, reason: 'invalid-signature' };

    this.pruneSeen(now);
    if (this.seenById.has(message.id) || this.seenByNonce.has(message.nonce)) return { accepted: false, reason: 'replay' };

    const seen = { id: message.id, nonce: message.nonce, expiresAt: message.expiresAt };
    this.seenById.set(seen.id, seen);
    this.seenByNonce.set(seen.nonce, seen);
    await this.persist();
    return { accepted: true, reason: 'accepted' };
  }

  async enqueueTask(input: Omit<FederationTask, 'id' | 'leaseId' | 'status' | 'attempt' | 'createdAt' | 'updatedAt'>): Promise<FederationTask> {
    this.assertInitialized();
    const now = new Date().toISOString();
    const task: FederationTask = {
      ...clone(input),
      id: `fedt_${randomUUID()}`,
      requiredCapabilities: [...new Set(input.requiredCapabilities)],
      status: 'queued',
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    await this.persist();
    return clone(task);
  }

  async importTask(task: FederationTask): Promise<FederationTask> {
    this.assertInitialized();
    const existing = this.tasks.get(task.id);
    if (existing) return clone(existing);
    validateTask(task);
    const imported: FederationTask = { ...normalizeTask(task), requiredCapabilities: [...new Set(task.requiredCapabilities)] };
    this.tasks.set(imported.id, imported);
    await this.persist();
    return clone(imported);
  }

  async updateTask(taskId: string, patch: Partial<Pick<FederationTask, 'status' | 'attempt' | 'assignedNodeId' | 'leaseId' | 'error'>>): Promise<FederationTask> {
    this.assertInitialized();
    const current = this.tasks.get(taskId);
    if (!current) throw new Error(`Unknown federation task: ${taskId}`);
    if (patch.attempt !== undefined && (!Number.isInteger(patch.attempt) || patch.attempt < 0)) throw new Error('Federation task attempt must be a non-negative integer');
    const updated: FederationTask = {
      ...current,
      ...clone(patch),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    await this.persist();
    return clone(updated);
  }

  async getTask(taskId: string): Promise<FederationTask | undefined> {
    this.assertInitialized();
    const task = this.tasks.get(taskId);
    return task ? clone(task) : undefined;
  }

  async listTasks(): Promise<FederationTask[]> {
    this.assertInitialized();
    return [...this.tasks.values()].map(clone);
  }

  async acquireLease(taskId: string, nodeId: string, options: FederationLeaseOptions): Promise<FederationLease> {
    this.assertInitialized();
    validateLeaseOptions(options);
    if (!nodeId.trim()) throw new Error('Federation lease nodeId is required');
    const now = options.now ?? Date.now();
    await this.recoverExpiredLeases(now);
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown federation task: ${taskId}`);
    if (task.status !== 'queued') throw new Error(`Federation task ${taskId} cannot be leased while ${task.status}`);
    if ([...this.leases.values()].some((lease) => lease.taskId === taskId)) throw new Error(`Federation task ${taskId} is already leased`);

    const attempt = task.attempt + 1;
    const at = new Date(now).toISOString();
    const lease: FederationLease = {
      id: `fedl_${randomUUID()}`,
      taskId,
      nodeId,
      attempt,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: now + options.leaseMs,
    };
    this.leases.set(lease.id, lease);
    task.status = 'running';
    task.attempt = attempt;
    task.assignedNodeId = nodeId;
    task.leaseId = lease.id;
    delete task.error;
    task.updatedAt = at;
    await this.persist();
    return clone(lease);
  }

  async heartbeatLease(leaseId: string, nodeId: string, options: FederationLeaseOptions): Promise<FederationLease> {
    this.assertInitialized();
    validateLeaseOptions(options);
    const now = options.now ?? Date.now();
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error(`Unknown federation lease: ${leaseId}`);
    if (lease.nodeId !== nodeId) throw new Error(`Federation lease ${leaseId} belongs to another node`);
    if (lease.expiresAt <= now) throw new Error(`Federation lease ${leaseId} has expired`);
    lease.heartbeatAt = new Date(now).toISOString();
    lease.expiresAt = now + options.leaseMs;
    await this.persist();
    return clone(lease);
  }

  async recoverExpiredLeases(now = Date.now()): Promise<FederationLease[]> {
    this.assertInitialized();
    const recovered: FederationLease[] = [];
    let changed = false;
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt > now) continue;
      recovered.push(clone(lease));
      this.leases.delete(leaseId);
      const task = this.tasks.get(lease.taskId);
      if (task && task.status === 'running' && task.leaseId === lease.id && !this.hasResultForAttempt(task.id, lease.attempt)) {
        task.status = 'queued';
        delete task.assignedNodeId;
        delete task.leaseId;
        task.updatedAt = new Date(now).toISOString();
      }
      changed = true;
    }
    if (changed) await this.persist();
    return recovered;
  }

  async listLeases(): Promise<FederationLease[]> {
    this.assertInitialized();
    return [...this.leases.values()].map(clone);
  }

  async appendResult(input: Omit<FederationResult, 'id' | 'createdAt' | 'attempt'> & { attempt?: number }): Promise<FederationResult> {
    this.assertInitialized();
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error(`Unknown federation task: ${input.taskId}`);
    const attempt = input.attempt ?? task.attempt;
    if (!Number.isInteger(attempt) || attempt < 0) throw new Error('Federation result attempt must be a non-negative integer');
    const result: FederationResult = {
      ...clone(input),
      id: `fedr_${randomUUID()}`,
      attempt,
      createdAt: new Date().toISOString(),
    };
    this.results.set(result.id, result);
    await this.persist();
    return clone(result);
  }

  async importResult(result: FederationResult): Promise<FederationResult> {
    this.assertInitialized();
    const existing = this.results.get(result.id);
    if (existing) return clone(existing);
    const task = this.tasks.get(result.taskId);
    if (!task) throw new Error(`Unknown federation task: ${result.taskId}`);
    const normalized = normalizeResult(result, task);
    validateResult(normalized);
    this.results.set(normalized.id, normalized);
    await this.persist();
    return clone(normalized);
  }

  async commitLeasedResult(result: FederationResult, now = Date.now()): Promise<FederationResult> {
    this.assertInitialized();
    const existing = this.results.get(result.id);
    if (existing) return clone(existing);
    validateResult(result);
    const task = this.tasks.get(result.taskId);
    if (!task) throw new Error(`Unknown federation task: ${result.taskId}`);
    if (!result.leaseId) throw new Error('Leased federation result requires leaseId');
    const lease = this.leases.get(result.leaseId);
    if (!lease) throw new Error('Stale federation result: lease is no longer active');
    if (lease.expiresAt <= now) throw new Error('Stale federation result: lease has expired');
    if (lease.taskId !== result.taskId || lease.nodeId !== result.nodeId || lease.attempt !== result.attempt) {
      throw new Error('Stale federation result: lease fencing mismatch');
    }
    if (task.executionId !== result.executionId || task.leaseId !== lease.id || task.assignedNodeId !== lease.nodeId || task.attempt !== lease.attempt || task.status !== 'running') {
      throw new Error('Stale federation result: task attempt is no longer current');
    }

    const committed = clone(result);
    this.results.set(committed.id, committed);
    this.leases.delete(lease.id);
    task.status = committed.success ? 'completed' : 'failed';
    delete task.leaseId;
    if (committed.success) delete task.error;
    else task.error = committed.error ?? 'Federation task failed';
    task.updatedAt = new Date(now).toISOString();
    await this.persist();
    return clone(committed);
  }

  async getResult(resultId: string): Promise<FederationResult | undefined> {
    this.assertInitialized();
    const result = this.results.get(resultId);
    return result ? clone(result) : undefined;
  }

  async findResultForTask(taskId: string, attempt?: number): Promise<FederationResult | undefined> {
    this.assertInitialized();
    const matches = [...this.results.values()].filter((candidate) => candidate.taskId === taskId && (attempt === undefined || candidate.attempt === attempt));
    matches.sort((left, right) => right.attempt - left.attempt || Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return matches[0] ? clone(matches[0]) : undefined;
  }

  async listResults(): Promise<FederationResult[]> {
    this.assertInitialized();
    return [...this.results.values()].map(clone);
  }

  private hasResultForAttempt(taskId: string, attempt: number): boolean {
    return [...this.results.values()].some((result) => result.taskId === taskId && result.attempt === attempt);
  }

  private signatureValid<T>(message: FederationMessage<T>): boolean {
    const unsigned = {
      id: message.id,
      from: message.from,
      to: message.to,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
      nonce: message.nonce,
      payload: message.payload,
    };
    const expected = createHmac('sha256', this.secret).update(JSON.stringify(unsigned)).digest('hex');
    const actualBytes = Buffer.from(message.signature);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  }

  private pruneSeen(now: number): void {
    for (const [id, seen] of this.seenById) {
      if (Date.parse(seen.expiresAt) > now) continue;
      this.seenById.delete(id);
      this.seenByNonce.delete(seen.nonce);
    }
  }

  private async persist(): Promise<void> {
    const state: FederationStateFileV2 = {
      version: 2,
      nodes: [...this.nodes.values()].map(clone),
      tasks: [...this.tasks.values()].map(clone),
      leases: [...this.leases.values()].map(clone),
      results: [...this.results.values()].map(clone),
      seenMessages: [...this.seenById.values()].map((seen) => ({ ...seen })),
    };
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.stateFile);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('DurableFederationState.init() must be called first');
  }
}

function validateNode(node: FederationNode): void {
  if (!node.id.trim()) throw new Error('Federation node id is required');
  if (!/^https?:\/\//.test(node.endpoint)) throw new Error('Federation endpoint must use http(s)');
  if (!Array.isArray(node.capabilities) || node.capabilities.some((capability) => !capability.trim())) throw new Error('Federation capabilities must be non-empty strings');
}

function validateTask(task: FederationTask): void {
  if (!task.id.trim() || !task.executionId.trim() || !task.taskType.trim() || !task.goal.trim()) throw new Error('Federation task identifiers and goal are required');
  if (!Array.isArray(task.requiredCapabilities) || task.requiredCapabilities.some((capability) => typeof capability !== 'string' || !capability.trim())) throw new Error('Federation task capabilities are invalid');
  if (!Number.isInteger(task.attempt) || task.attempt < 0) throw new Error('Federation task attempt must be a non-negative integer');
  if (task.leaseId !== undefined && !task.leaseId.trim()) throw new Error('Federation task leaseId is invalid');
}

function validateResult(result: FederationResult): void {
  if (!result.id.trim() || !result.taskId.trim() || !result.executionId.trim() || !result.nodeId.trim()) throw new Error('Federation result identifiers are required');
  if (!Number.isInteger(result.attempt) || result.attempt < 0) throw new Error('Federation result attempt must be a non-negative integer');
  if (result.leaseId !== undefined && !result.leaseId.trim()) throw new Error('Federation result leaseId is invalid');
  if (!Number.isFinite(Date.parse(result.createdAt))) throw new Error('Federation result createdAt is invalid');
}

function validateLeaseOptions(options: FederationLeaseOptions): void {
  if (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0) throw new Error('Federation leaseMs must be greater than zero');
  if (options.now !== undefined && !Number.isFinite(options.now)) throw new Error('Federation lease now must be finite');
}

function normalizeTask(task: FederationTask): FederationTask {
  const normalized = clone(task);
  if (normalized.leaseId === undefined) delete normalized.leaseId;
  return normalized;
}

function normalizeLease(lease: FederationLease): FederationLease {
  if (!lease.id.trim() || !lease.taskId.trim() || !lease.nodeId.trim()) throw new Error('Federation lease identifiers are required');
  if (!Number.isInteger(lease.attempt) || lease.attempt < 1) throw new Error('Federation lease attempt must be a positive integer');
  if (!Number.isFinite(lease.expiresAt)) throw new Error('Federation lease expiresAt is invalid');
  if (!Number.isFinite(Date.parse(lease.acquiredAt)) || !Number.isFinite(Date.parse(lease.heartbeatAt))) throw new Error('Federation lease timestamps are invalid');
  return clone(lease);
}

function normalizeResult(result: LegacyFederationResult | FederationResult, task?: FederationTask): FederationResult {
  return {
    ...clone(result),
    attempt: result.attempt ?? task?.attempt ?? 0,
  };
}

function normalizeLoad(load: number | undefined): number {
  if (load === undefined) return 0;
  if (!Number.isFinite(load) || load < 0) throw new Error('Federation node load must be a non-negative number');
  return load;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
