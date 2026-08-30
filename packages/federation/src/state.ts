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
  status: FederationTaskStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface FederationResult {
  id: string;
  taskId: string;
  executionId: string;
  nodeId: string;
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

interface FederationStateFile {
  version: 1;
  nodes: FederationNode[];
  tasks: FederationTask[];
  results: FederationResult[];
  seenMessages: SeenMessage[];
}

export interface DurableFederationStateOptions {
  stateFile: string;
  localNodeId: string;
  secret: string;
}

export class DurableFederationState {
  private readonly stateFile: string;
  private readonly localNodeId: string;
  private readonly secret: string;
  private nodes = new Map<string, FederationNode>();
  private tasks = new Map<string, FederationTask>();
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
      if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.results) || !Array.isArray(parsed.seenMessages)) {
        throw new Error('Invalid durable federation state');
      }
      this.nodes = new Map(parsed.nodes.map((node) => [node.id, clone(node)]));
      this.tasks = new Map(parsed.tasks.map((task) => [task.id, clone(task)]));
      this.results = new Map(parsed.results.map((result) => [result.id, clone(result)]));
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

  async enqueueTask(input: Omit<FederationTask, 'id' | 'status' | 'attempt' | 'createdAt' | 'updatedAt'>): Promise<FederationTask> {
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
    const imported: FederationTask = { ...clone(task), requiredCapabilities: [...new Set(task.requiredCapabilities)] };
    this.tasks.set(imported.id, imported);
    await this.persist();
    return clone(imported);
  }

  async updateTask(taskId: string, patch: Partial<Pick<FederationTask, 'status' | 'attempt' | 'assignedNodeId' | 'error'>>): Promise<FederationTask> {
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

  async appendResult(input: Omit<FederationResult, 'id' | 'createdAt'>): Promise<FederationResult> {
    this.assertInitialized();
    if (!this.tasks.has(input.taskId)) throw new Error(`Unknown federation task: ${input.taskId}`);
    const result: FederationResult = {
      ...clone(input),
      id: `fedr_${randomUUID()}`,
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
    if (!this.tasks.has(result.taskId)) throw new Error(`Unknown federation task: ${result.taskId}`);
    validateResult(result);
    const imported = clone(result);
    this.results.set(imported.id, imported);
    await this.persist();
    return clone(imported);
  }

  async getResult(resultId: string): Promise<FederationResult | undefined> {
    this.assertInitialized();
    const result = this.results.get(resultId);
    return result ? clone(result) : undefined;
  }

  async findResultForTask(taskId: string): Promise<FederationResult | undefined> {
    this.assertInitialized();
    const result = [...this.results.values()].find((candidate) => candidate.taskId === taskId);
    return result ? clone(result) : undefined;
  }

  async listResults(): Promise<FederationResult[]> {
    this.assertInitialized();
    return [...this.results.values()].map(clone);
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
    const state: FederationStateFile = {
      version: 1,
      nodes: [...this.nodes.values()].map(clone),
      tasks: [...this.tasks.values()].map(clone),
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
}

function validateResult(result: FederationResult): void {
  if (!result.id.trim() || !result.taskId.trim() || !result.executionId.trim() || !result.nodeId.trim()) throw new Error('Federation result identifiers are required');
  if (!Number.isFinite(Date.parse(result.createdAt))) throw new Error('Federation result createdAt is invalid');
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
