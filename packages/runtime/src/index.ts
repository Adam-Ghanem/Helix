import { join } from 'node:path';
import { AgentRegistry } from '../../agents/src/index.js';
import { EventStore } from '../../durable/src/index.js';
import { DEFAULT_BUDGET, EventEnvelope, ExecutionInput, ExecutionRecord, ResourceUsage, StructuredDecision, TaskRecord, ToolRequest, id, timestamp, withDefaultBudget } from '../../core/src/index.js';
import { defaultPlan, TaskGraph } from '../../planner/src/index.js';
import { AgentRouter, RoutingCandidate } from '../../router/src/index.js';
import { PolicyEngine, secureDefaultRules } from '../../policy/src/index.js';
import { LeaseScheduler } from '../../scheduler/src/index.js';
import { MemoryQuery, MemoryRecord, MemoryBackend, MemoryStore, SqliteMemoryStore, MemoryAccessContext, MemoryCompactionOptions, MemoryCompactionResult, MemoryEntry, MemoryEntryInput, MemorySearchOptions, TaskOutcomeLearningInput } from '../../memory/src/index.js';
import { PersistentLearningEngine } from '../../learning/src/intelligence.js';
import { Telemetry } from '../../observability/src/index.js';
import { defaultAuditFile, SandboxManager } from '../../sandbox/src/index.js';
import { defaultSandboxPolicy, SandboxPolicy } from '../../sandbox/src/types.js';
import { SandboxExecutionRequest } from '../../core/src/index.js';
import { ToolRegistry, PublicToolDefinition } from '../../tools/src/index.js';
import { registerHelixMemoryTools } from '../../mcp/src/index.js';
import { HelixOrchestrator, type OrchestratorOptions } from '../../intelligence/src/index.js';
import { DynamicSwarmManager } from '../../swarm/src/index.js';
import { FederationCoordinator, FederationNodeRuntime, HmacMessageSigner, HmacMessageVerifier, SqliteInboxStore, SqliteOutboxStore } from '../../federation/src/index.js';
import type { FederationExecutionOutcome, FederationRuntimeOptions, FederationSecurityContext, FederationTimeoutKind } from '../../federation/src/index.js';

export interface ProviderResult {
  output: unknown;
  tokens: number;
  costUsd: number;
  quality: number;
}

export interface ModelProvider {
  readonly name: string;
  execute(input: { goal: string; task: TaskRecord; agent: string }): Promise<ProviderResult>;
}

export class HttpModelProvider implements ModelProvider {
  readonly name: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: { endpoint: string; apiKey: string; model: string; timeoutMs?: number; name?: string }) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.name = options.name ?? 'openai-compatible-http';
  }

  async execute(input: { goal: string; task: TaskRecord; agent: string }): Promise<ProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: 'You are a bounded Helix worker. Return concise, evidence-oriented output.' }, { role: 'user', content: `Goal: ${input.goal}\\nTask: ${input.task.title}\\nDescription: ${input.task.description}\\nAgent: ${input.agent}` }], temperature: 0.2 }),
      });
      if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Model provider returned no assistant content');
      return { output: { content, provider: this.name, model: this.model }, tokens: payload.usage?.total_tokens ?? 0, costUsd: 0, quality: 0.5 };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`Model provider timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class DeterministicProvider implements ModelProvider {
  readonly name = 'deterministic-local';

  async execute(input: { goal: string; task: TaskRecord; agent: string }): Promise<ProviderResult> {
    return {
      output: {
        summary: `${input.task.title} completed within Helix’s local execution boundary`,
        goal: input.goal,
        assignedAgent: input.agent,
        evidence: ['provider-neutral deterministic execution'],
      },
      tokens: 0,
      costUsd: 0,
      quality: 0.75,
    };
  }
}

export interface RuntimeOptions {
  dataDirectory: string;
  provider?: ModelProvider;
  agents?: AgentRegistry;
  router?: AgentRouter;
  policy?: PolicyEngine;
  scheduler?: LeaseScheduler;
  memory?: MemoryBackend;
  useSqliteMemory?: boolean;
  telemetry?: Telemetry;
  sandboxManager?: SandboxManager;
  learning?: PersistentLearningEngine;
  learningAsync?: boolean;
  federation?: FederationCoordinator;
  federationKey?: { keyId: string; secret: string };
  federationRuntime?: FederationRuntimeOptions;
}

export interface ExecutionView {
  execution: ExecutionRecord;
  tasks: TaskRecord[];
  events: EventEnvelope[];
}

export interface FederatedRuntimeTaskInput {
  taskId: string;
  title: string;
  description?: string;
  goal?: string;
  requiredCapabilities: string[];
  priority?: number;
  correlationId: string;
  traceId: string;
  securityContext: FederationSecurityContext;
  authorizationContext: Record<string, string>;
  executionTimeoutMs?: number;
  sandbox?: SandboxExecutionRequest;
  signal?: AbortSignal;
}

export interface FederatedOutcomeLearningInput {
  executionId: string;
  taskId: string;
  taskType: string;
  agentId: string;
  sourceNodeId: string;
  attemptId: string;
  capabilities: string[];
  success: boolean;
  quality: number;
  executionTimeMs: number;
  output?: unknown;
  error?: string;
}

export class HelixRuntime {
  readonly events: EventStore;
  readonly agents: AgentRegistry;
  readonly router: AgentRouter;
  readonly policy: PolicyEngine;
  readonly scheduler: LeaseScheduler;
  readonly provider: ModelProvider;
  readonly memory: MemoryBackend;
  readonly telemetry: Telemetry;
  readonly sandbox: SandboxManager;
  readonly learning: PersistentLearningEngine;
  readonly swarms: DynamicSwarmManager;
  readonly federation: FederationCoordinator;
  readonly federationRuntime: FederationNodeRuntime;
  readonly learningAsync: boolean;
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly graphs = new Map<string, TaskGraph>();
  private readonly federatedInputs = new Map<string, FederatedRuntimeTaskInput>();
  private readonly federatedTaskExecutions = new Map<string, string>();
  private readonly federatedControllers = new Map<string, AbortController>();
  private initialized = false;

  constructor(options: RuntimeOptions) {
    this.events = new EventStore({ directory: options.dataDirectory });
    this.agents = options.agents ?? new AgentRegistry();
    this.router = options.router ?? new AgentRouter();
    this.policy = options.policy ?? new PolicyEngine(secureDefaultRules);
    this.scheduler = options.scheduler ?? new LeaseScheduler({ stateFile: join(options.dataDirectory, 'helix.leases.json') });
    this.provider = options.provider ?? new DeterministicProvider();
    this.memory = options.memory ?? (options.useSqliteMemory === false ? new MemoryStore(options.dataDirectory) : new SqliteMemoryStore(join(options.dataDirectory, 'helix.memory.sqlite')));
    this.telemetry = options.telemetry ?? new Telemetry();
    this.sandbox = options.sandboxManager ?? new SandboxManager({ auditFile: defaultAuditFile(options.dataDirectory) });
    this.learning = options.learning ?? new PersistentLearningEngine(this.memory);
    this.swarms = new DynamicSwarmManager({ agents: this.agents, router: this.router, scheduler: this.scheduler, memory: this.memory, subject: 'runtime', eventSink: async (event) => { await this.events.append({ type: event.type, payload: { swarmId: event.swarmId, ...event.payload } }); } });
    const localCapabilities = [...new Set(this.agents.list().flatMap((agent) => agent.capabilities))];
    if (options.federation) this.federation = options.federation;
    else {
      const signer = options.federationKey ? new HmacMessageSigner(options.federationKey.secret, options.federationKey.keyId) : undefined;
      const verifier = options.federationKey ? new HmacMessageVerifier(options.federationKey.secret, undefined, 30_000, Date.now, options.federationKey.keyId) : undefined;
      this.federation = new FederationCoordinator({ localNode: { name: 'helix-local', endpoint: 'in-memory://local', role: 'hybrid', capabilities: localCapabilities, status: 'healthy', trustLevel: 'ADMIN', metadata: { runtime: 'helix' } }, eventSink: async (event) => { await this.events.append({ type: event.type, payload: event.payload }); }, inbox: new SqliteInboxStore(join(options.dataDirectory, 'helix.federation.sqlite')), outbox: new SqliteOutboxStore(join(options.dataDirectory, 'helix.federation.sqlite')), ...(signer ? { signer } : {}), ...(verifier ? { verifier } : {}) });
    }
    this.federationRuntime = new FederationNodeRuntime({ runtime: this, coordinator: this.federation, ...(options.federationRuntime ?? {}) });
    this.learningAsync = options.learningAsync ?? true;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.events.init();
    await this.memory.init();
    await this.sandbox.init();
    for (const event of await this.events.read()) this.rebuild(event);
    this.initialized = true;
  }

  async executeFederatedTask(input: FederatedRuntimeTaskInput): Promise<FederationExecutionOutcome> {
    await this.init();
    const executionId = id('fed-ex');
    const task: TaskRecord = { id: input.taskId, executionId, title: input.title, description: input.description ?? input.title, dependencies: [], status: 'ready', attempts: 0 };
    const execution: ExecutionRecord = { id: executionId, goal: input.goal ?? input.title, status: 'running', createdAt: timestamp(), updatedAt: timestamp(), taskIds: [task.id], budget: withDefaultBudget({ maxAgents: 1, maxTasks: 1, ...(input.executionTimeoutMs !== undefined ? { maxRuntimeMs: input.executionTimeoutMs } : {}) }), usage: { agents: 0, tasks: 1, toolCalls: 0, tokens: 0, costUsd: 0, runtimeMs: 0, delegationDepth: 0 } };
    this.executions.set(execution.id, execution);
    this.graphs.set(execution.id, new TaskGraph([task]));
    this.federatedInputs.set(task.id, input);
    this.federatedTaskExecutions.set(task.id, execution.id);
    const controller = new AbortController();
    const signal = input.signal;
    const abortForwarder = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', abortForwarder, { once: true }); }
    this.federatedControllers.set(task.id, controller);
    const startedAt = timestamp();
    await this.events.append({ type: 'federated.execution.started', executionId, taskId: task.id, correlationId: input.correlationId, payload: { taskId: task.id, nodeId: input.authorizationContext.nodeId ?? 'local', correlationId: input.correlationId, traceId: input.traceId, securityContext: input.securityContext, authorizationContext: input.authorizationContext } });
    await this.events.append({ type: 'task.created', executionId, taskId: task.id, correlationId: input.correlationId, payload: task, idempotencyKey: `federated:${task.id}:created` });
    let timeoutKind: FederationTimeoutKind | undefined;
    const executionPromise = this.runExecution(execution.id);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const executionTimeoutMs = input.executionTimeoutMs;
    const timeoutPromise = executionTimeoutMs === undefined ? undefined : new Promise<void>((resolve) => { timeoutHandle = setTimeout(() => { timeoutKind = 'EXECUTION_TIMEOUT'; controller.abort(); resolve(); }, Math.max(1, executionTimeoutMs)); });
    if (timeoutPromise) await Promise.race([executionPromise, timeoutPromise]); else await executionPromise;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (controller.signal.aborted && execution.status === 'running') { execution.status = 'cancelled'; execution.error = timeoutKind ? 'federated task execution timed out' : 'federated task cancelled'; execution.updatedAt = timestamp(); await this.events.append({ type: timeoutKind ? 'federated.execution.timeout' : 'federated.execution.cancelled', executionId, taskId: task.id, correlationId: input.correlationId, payload: { taskId: task.id, traceId: input.traceId, timeout: timeoutKind } }); }
    if (signal) signal.removeEventListener('abort', abortForwarder);
    const finalTask = this.graphs.get(execution.id)!.get(task.id);
    const assignedAgentId = finalTask.assignedAgentId;
    const completedAt = timestamp();
    const status: FederationExecutionOutcome['status'] = execution.status === 'completed' && finalTask.status === 'completed' ? 'completed' : execution.status === 'cancelled' ? 'cancelled' : 'failed';
    const error = status === 'completed' ? undefined : execution.error ?? finalTask.error ?? (status === 'cancelled' ? 'federated task cancelled' : 'federated task failed');
    const outcome: FederationExecutionOutcome = { taskId: task.id, attemptId: `${task.id}:attempt:${finalTask.attempts}`, nodeId: input.authorizationContext.nodeId ?? 'local', status, ...(status === 'completed' ? { output: structuredClone(finalTask.result) } : {}), ...(error ? { error } : {}), ...(timeoutKind ? { timeout: timeoutKind } : {}), startedAt, completedAt, provenance: { ...(input.authorizationContext.sourceNodeId ? { sourceNodeId: input.authorizationContext.sourceNodeId } : {}), ...(assignedAgentId ? { agentId: assignedAgentId } : {}), taskId: task.id, attemptId: `${task.id}:attempt:${finalTask.attempts}`, timestamp: completedAt } };
    this.federatedControllers.delete(task.id); this.federatedInputs.delete(task.id); this.federatedTaskExecutions.delete(task.id);
    return outcome;
  }

  async cancelFederatedTask(taskId: string): Promise<FederationExecutionOutcome | undefined> {
    const controller = this.federatedControllers.get(taskId);
    const executionId = this.federatedTaskExecutions.get(taskId);
    if (!controller || !executionId) return undefined;
    controller.abort();
    const execution = this.executions.get(executionId);
    if (execution && execution.status === 'running') { execution.status = 'cancelled'; execution.error = 'federated task cancelled'; execution.updatedAt = timestamp(); await this.events.append({ type: 'federated.execution.cancelled', executionId, taskId, payload: { taskId } }); }
    return undefined;
  }

  async execute(input: ExecutionInput): Promise<ExecutionRecord> {
    await this.init();
    const executionSpan = this.telemetry.startSpan('helix.execution', { 'execution.goal_length': input.goal.length, provider: this.provider.name });
    const execution: ExecutionRecord = {
      id: id('ex'),
      goal: input.goal,
      status: 'running',
      createdAt: timestamp(),
      updatedAt: timestamp(),
      taskIds: [],
      budget: withDefaultBudget(input.budget),
      usage: { agents: 0, tasks: 0, toolCalls: 0, tokens: 0, costUsd: 0, runtimeMs: 0, delegationDepth: 0 },
    };
    const graph = defaultPlan(input.goal, execution.id);
    const tasks = graph.all();
    if (tasks.length > execution.budget.maxTasks) throw new Error('Execution exceeds maxTasks budget');
    execution.taskIds = tasks.map((task) => task.id);
    execution.usage.tasks = tasks.length;
    this.executions.set(execution.id, execution);
    this.graphs.set(execution.id, graph);
    await this.events.append({ type: 'execution.started', executionId: execution.id, payload: { execution, idempotencyKey: `execution:${execution.id}:started` }, idempotencyKey: `execution:${execution.id}:started` });
    for (const task of tasks) await this.events.append({ type: 'task.created', executionId: execution.id, taskId: task.id, payload: task, idempotencyKey: `task:${task.id}:created` });
    await this.events.append({ type: 'plan.created', executionId: execution.id, payload: { taskIds: execution.taskIds, criticalPathMs: graph.criticalPathMs() } });
    const sandboxResult = input.sandbox?.enabled && input.sandbox.command ? await this.executeSandboxRequest(input.sandbox, execution.id) : undefined;
    await this.runExecution(execution.id);
    const completed = this.executions.get(execution.id)!;
    if (sandboxResult) {
      completed.result = { ...(completed.result as Record<string, unknown>), sandbox: sandboxResult };
      await this.events.append({ type: 'sandbox.execution.completed', executionId: execution.id, payload: sandboxResult });
      try {
        await this.learning.recordSandboxResult(execution.id, sandboxResult);
      } catch (error) {
        await this.events.append({ type: 'learning.persistence.failed', executionId: execution.id, payload: { error: error instanceof Error ? error.message : String(error) } });
      }
    }
    this.telemetry.endSpan(executionSpan, completed.status === 'failed' ? 'error' : 'ok', completed.error);
    this.telemetry.recordMetric('helix.execution.completed', 1, { status: completed.status, provider: this.provider.name });
    return structuredClone(completed);
  }

  private async executeSandboxRequest(request: SandboxExecutionRequest, executionId: string, agentId?: string, signal?: AbortSignal) {
    if (!request.command) throw new Error('Sandbox command is required when sandboxing is enabled');
    const workspace = request.policy?.workspacePath ?? process.cwd();
    const defaults = defaultSandboxPolicy(workspace);
    const policy: SandboxPolicy = { ...defaults, ...request.policy, allowedExecutables: request.policy?.allowedExecutables ?? defaults.allowedExecutables, allowedPaths: request.policy?.allowedPaths ?? defaults.allowedPaths, deniedPaths: request.policy?.deniedPaths ?? defaults.deniedPaths, environmentAllowlist: request.policy?.environmentAllowlist ?? defaults.environmentAllowlist };
    const created = await this.sandbox.create({ policy, executionId, ...(agentId ? { agentId } : {}), ...(request.backend ? { backend: request.backend } : {}) });
    await this.events.append({ type: 'sandbox.created', executionId, payload: created });
    await this.sandbox.start(created.sandboxId);
    await this.events.append({ type: 'sandbox.started', executionId, payload: this.sandbox.status(created.sandboxId) });
    const abort = () => { void this.sandbox.stop(created.sandboxId); };
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    try {
      return await this.sandbox.exec(created.sandboxId, { command: request.command.command, args: request.command.args ?? [], cwd: request.command.cwd ?? '.', env: request.command.env ?? {}, ...(request.command.stdin !== undefined ? { stdin: request.command.stdin } : {}), ...(request.command.timeoutMs !== undefined ? { timeoutMs: request.command.timeoutMs } : {}) });
    } finally { if (signal) signal.removeEventListener('abort', abort);
      await this.sandbox.destroy(created.sandboxId);
      await this.events.append({ type: 'sandbox.destroyed', executionId, payload: this.sandbox.status(created.sandboxId) });
    }
  }

  createOrchestrator(options: OrchestratorOptions = {}): HelixOrchestrator { return new HelixOrchestrator(this, options); }
  async startFederationRuntime() { return this.federationRuntime.start(); }
  async stopFederationRuntime() { return this.federationRuntime.stop(); }
  federationRuntimeStatus() { return this.federationRuntime.status(); }

  async remember(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    await this.init();
    return this.memory.store(input);
  }

  async rememberEntry(input: MemoryEntryInput, context?: MemoryAccessContext): Promise<MemoryEntry> {
    await this.init();
    return this.memory.create(input, context);
  }

  async recall(query: MemoryQuery) {
    await this.init();
    return this.memory.search(query);
  }

  async searchMemory(options: MemorySearchOptions) {
    await this.init();
    return this.memory.searchEntries(options);
  }

  async getMemory(memoryId: string, context?: MemoryAccessContext): Promise<MemoryEntry> {
    await this.init();
    return this.memory.get(memoryId, context);
  }

  async updateMemory(memoryId: string, input: Parameters<MemoryStore['update']>[1], context: MemoryAccessContext): Promise<MemoryEntry> {
    await this.init();
    return this.memory.update(memoryId, input, context);
  }

  async deleteMemory(memoryId: string, context: MemoryAccessContext): Promise<void> {
    await this.init();
    return this.memory.delete(memoryId, context);
  }

  async memoryStats(context?: MemoryAccessContext) {
    await this.init();
    return this.memory.stats(context);
  }

  async compactMemory(options: MemoryCompactionOptions = {}): Promise<MemoryCompactionResult> {
    await this.init();
    if (!this.memory.compact) return { removedDuplicates: 0, removedExpiredLegacy: 0, vacuumed: false };
    return this.memory.compact(options);
  }

  memoryCacheSize(): number {
    return this.memory.cacheSize?.() ?? 0;
  }

  async learningHints(taskType: string, requiredCapabilities: string[], context?: MemoryAccessContext) {
    await this.init();
    return this.learning.suggestRouting({ taskType, requiredCapabilities, complexity: 0.5 }, context);
  }

  async agentExperience(agentId: string) {
    await this.init();
    return this.learning.getAgentExperience(agentId);
  }

  async recordLearningOutcome(input: TaskOutcomeLearningInput): Promise<MemoryEntry[]> {
    await this.init();
    return input.success ? this.learning.recordSuccess(input) : this.learning.recordFailure(input);
  }

  async recordFederatedOutcome(input: FederatedOutcomeLearningInput): Promise<MemoryEntry> {
    await this.init();
    const content = input.success ? `Federated task ${input.taskId} completed on ${input.sourceNodeId}` : `Federated task ${input.taskId} failed on ${input.sourceNodeId}: ${input.error ?? 'unknown failure'}`;
    return this.memory.create({ namespace: 'global', type: input.success ? 'observation' : 'failure', content, metadata: { sourceNodeId: input.sourceNodeId, attemptId: input.attemptId, success: input.success, quality: input.quality, executionTimeMs: input.executionTimeMs }, source: 'federation', agentId: input.agentId as import('../../core/src/index.js').AgentId, taskId: input.taskId, confidence: Math.max(0, Math.min(1, input.quality)), tags: ['federation', input.success ? 'success' : 'failure'], provenance: { sourceType: 'task-outcome', sourceId: `federation:${input.sourceNodeId}:${input.attemptId}`, timestamp: new Date().toISOString(), confidence: Math.max(0, Math.min(1, input.quality)), agentId: input.agentId as import('../../core/src/index.js').AgentId, taskId: input.taskId, executionId: input.executionId, sourceNodeId: input.sourceNodeId }, accessPolicy: { visibility: 'shared', allowedSubjects: ['runtime', 'federation-coordinator'], allowedSwarmIds: [], owner: 'federation-coordinator' } }, { subject: 'federation-coordinator' });
  }

  async flushLearning(): Promise<void> {
    await this.learning.flush();
  }

  registerMemoryTools(registry: ToolRegistry): PublicToolDefinition[] {
    return registerHelixMemoryTools(registry, {
      search: async (input) => this.searchMemory({ query: stringInput(input, 'query'), limit: 20, context: { subject: stringInput(input, 'subject', 'mcp-user') } }),
      get: async (input) => this.getMemory(stringInput(input, 'id'), { subject: stringInput(input, 'subject', 'mcp-user') }),
      list: async (input) => this.memory.listEntries({ subject: stringInput(input, 'subject', 'mcp-user') }),
      stats: async (input) => this.memoryStats({ subject: stringInput(input, 'subject', 'mcp-user') }),
      recall: async (input) => this.searchMemory({ query: stringInput(input, 'query'), types: ['solution', 'pattern', 'failure', 'routing-hint'], limit: 20, context: { subject: stringInput(input, 'subject', 'mcp-user') } }),
      routingHints: async (input) => this.learningHints(stringInput(input, 'taskType'), arrayInput(input, 'capabilities'), { subject: stringInput(input, 'subject', 'mcp-user') }),
      agentExperience: async (input) => this.agentExperience(stringInput(input, 'agentId')),
    });
  }

  telemetrySnapshot() {
    return this.telemetry.snapshot();
  }

  async view(executionId: string): Promise<ExecutionView> {
    await this.init();
    const execution = this.executions.get(executionId);
    const graph = this.graphs.get(executionId);
    if (!execution || !graph) throw new Error(`Unknown execution: ${executionId}`);
    return { execution: structuredClone(execution), tasks: graph.all(), events: await this.events.read((event) => event.executionId === executionId) };
  }

  async requestTool(request: ToolRequest): Promise<{ allowed: boolean; reason: string; approvalId?: string }> {
    const decision = this.policy.decide(request, { subject: request.agentId });
    await this.events.append({ type: 'tool.policy_decided', executionId: request.executionId, agentId: request.agentId, payload: { request, decision } });
    return { allowed: decision.action === 'allow', reason: decision.reason, ...(decision.approvalId ? { approvalId: decision.approvalId } : {}) };
  }

  async pause(executionId: string): Promise<ExecutionRecord> {
    await this.init();
    const execution = this.requireExecution(executionId);
    if (execution.status === 'running') {
      execution.status = 'paused';
      execution.updatedAt = timestamp();
      await this.events.append({ type: 'execution.paused', executionId, payload: { execution } });
    }
    return structuredClone(execution);
  }

  async resume(executionId: string): Promise<ExecutionRecord> {
    await this.init();
    const execution = this.requireExecution(executionId);
    if (execution.status === 'paused') {
      execution.status = 'running';
      execution.updatedAt = timestamp();
      await this.events.append({ type: 'execution.resumed', executionId, payload: { execution } });
      await this.runExecution(executionId);
    }
    return structuredClone(execution);
  }

  async cancel(executionId: string): Promise<ExecutionRecord> {
    await this.init();
    const execution = this.requireExecution(executionId);
    if (['running', 'paused'].includes(execution.status)) {
      execution.status = 'cancelled';
      execution.updatedAt = timestamp();
      await this.events.append({ type: 'execution.cancelled', executionId, payload: { execution } });
    }
    return structuredClone(execution);
  }

  async retry(executionId: string): Promise<ExecutionRecord> {
    await this.init();
    const execution = this.requireExecution(executionId);
    const graph = this.requireGraph(executionId);
    if (execution.status !== 'failed') throw new Error(`Execution ${executionId} is not failed`);
    const retried = graph.retryFailed();
    execution.status = 'running';
    delete execution.error;
    execution.updatedAt = timestamp();
    await this.events.append({ type: 'execution.retry_requested', executionId, payload: { taskIds: retried } });
    await this.runExecution(executionId);
    return structuredClone(execution);
  }

  async checkpoint(executionId: string): Promise<{ sequence: number; createdAt: string }> {
    await this.init();
    const execution = this.requireExecution(executionId);
    const graph = this.requireGraph(executionId);
    const snapshot = await this.events.snapshot({ executions: [execution], tasks: graph.all() });
    await this.events.append({ type: 'execution.checkpointed', executionId, payload: { sequence: snapshot.sequence } });
    return { sequence: snapshot.sequence, createdAt: snapshot.createdAt };
  }

  async recover(): Promise<number> {
    await this.init();
    const recoveredLeases = this.scheduler.recoverExpired();
    for (const lease of recoveredLeases) await this.events.append({ type: 'task.lease_recovered', taskId: lease.taskId, payload: lease });
    const resumable = [...this.executions.values()].filter((execution) => execution.status === 'running');
    for (const execution of resumable) {
      this.requireGraph(execution.id).resetRunningForRecovery();
      await this.events.append({ type: 'execution.recovered', executionId: execution.id, payload: { execution } });
    }
    await Promise.all(resumable.map((execution) => this.runExecution(execution.id)));
    return recoveredLeases.length + resumable.length;
  }

  private async runExecution(executionId: string): Promise<void> {
    const execution = this.executions.get(executionId)!;
    const graph = this.graphs.get(executionId)!;
    const started = Date.now();
    try {
      while (execution.status === 'running' && graph.all().some((task) => ['pending', 'ready', 'running'].includes(task.status))) {
        const ready = graph.ready();
        if (!ready.length) {
          if (graph.all().some((task) => task.status === 'running')) break;
          throw new Error('Execution stalled: no ready tasks and incomplete graph');
        }
        await Promise.all(ready.map((task) => this.runTask(execution, graph, task)));
        if (Date.now() - started > execution.budget.maxRuntimeMs) throw new Error('Execution exceeded runtime budget');
      }
      if (execution.status !== 'running') return;
      const failed = graph.all().filter((task) => task.status === 'failed');
      execution.status = failed.length ? 'failed' : 'completed';
      execution.updatedAt = timestamp();
      execution.usage.runtimeMs = Date.now() - started;
      execution.result = { completedTasks: graph.all().filter((task) => task.status === 'completed').length, failedTasks: failed.length };
      await this.events.append({ type: `execution.${execution.status}`, executionId, payload: { execution } });
    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : String(error);
      execution.updatedAt = timestamp();
      execution.usage.runtimeMs = Date.now() - started;
      await this.events.append({ type: 'execution.failed', executionId, payload: { execution, error: execution.error } });
    }
  }

  private async runTask(execution: ExecutionRecord, graph: TaskGraph, task: TaskRecord): Promise<void> {
    const taskStarted = Date.now();
    const federated = this.federatedInputs.get(task.id);
    const request = { taskType: task.title.toLowerCase().replaceAll(' ', '-'), requiredCapabilities: federated?.requiredCapabilities ?? ['analysis'], complexity: 0.5, maxCostUsd: execution.budget.maxCostUsd };
    const candidates: RoutingCandidate[] = this.agents.list().map((agent) => ({ agent, estimatedCostUsd: 0, availability: agent.status === 'idle' ? 1 : 0.5, memoryRelevance: 0.5 }));
    const learningScores = await this.learning.routingScores(request, candidates);
    const enrichedCandidates = candidates.map((candidate) => ({ ...candidate, learningBonus: learningScores.get(candidate.agent.id) ?? 0 }));
    const route = this.router.route(request, enrichedCandidates, 'adaptive');
    const agent = this.agents.get(route.agentId);
    graph.update(task.id, { assignedAgentId: agent.id, attempts: task.attempts + 1 });
    graph.setStatus(task.id, 'running');
    this.agents.setStatus(agent.id, 'busy');
    execution.usage.agents = Math.min(execution.budget.maxAgents, execution.usage.agents + 1);
    await this.events.append({ type: 'task.started', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { task, route } });
    let lease: ReturnType<LeaseScheduler['acquire']>;
    try {
      lease = this.scheduler.acquire(task.id, agent.id);
      if (!lease) throw new Error(`Scheduler rejected task ${task.id}`);
      const observation: StructuredDecision = { decision: 'execute bounded task', confidence: route.score, evidence: route.rationale, constraints: ['no private chain-of-thought', 'policy-controlled tools'], selectedStrategy: route.strategy };
      await this.events.append({ type: 'agent.decision', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: observation });
      const result = federated?.sandbox ? await this.executeSandboxRequest(federated.sandbox, execution.id, agent.id, this.federatedControllers.get(task.id)?.signal) : await this.provider.execute({ goal: execution.goal, task, agent: agent.name });
      if (this.federatedControllers.get(task.id)?.signal.aborted || execution.status === 'cancelled') throw new Error('federated task cancelled');
      const normalizedResult: ProviderResult = 'output' in result && 'tokens' in result ? result as ProviderResult : { output: result, tokens: 0, costUsd: 0, quality: 0.75 };
      execution.usage.tokens += normalizedResult.tokens;
      execution.usage.costUsd += normalizedResult.costUsd;
      if (execution.usage.tokens > execution.budget.maxTokens || execution.usage.costUsd > execution.budget.maxCostUsd) throw new Error('Execution exceeded token or cost budget');
      graph.update(task.id, { result: normalizedResult.output });
      graph.setStatus(task.id, 'completed');
      this.agents.recordOutcome(agent.id, { taskType: request.taskType, domain: 'general', success: true, quality: normalizedResult.quality, latencyMs: Date.now() - taskStarted, tokens: normalizedResult.tokens, costUsd: normalizedResult.costUsd });
      await this.events.append({ type: 'task.completed', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { result: normalizedResult.output, evaluation: { success: true, quality: normalizedResult.quality, provider: this.provider.name } } });
      const learningInput = { executionId: execution.id, taskId: task.id, taskType: request.taskType, agentId: agent.id, capabilities: request.requiredCapabilities, success: true, quality: normalizedResult.quality, executionTimeMs: Date.now() - taskStarted, attempts: task.attempts + 1, output: normalizedResult.output };
      if (this.learningAsync) {
        this.learning.enqueueSuccess(learningInput);
        await this.events.append({ type: 'learning.outcome.queued', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { success: true, pendingWrites: this.learning.pendingWrites } });
      } else {
        try {
          const learned = await this.learning.recordSuccess(learningInput);
          await this.events.append({ type: 'learning.outcome.recorded', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { success: true, memoryIds: learned.map((entry) => entry.id) } });
        } catch (learningError) {
          await this.events.append({ type: 'learning.persistence.failed', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { error: learningError instanceof Error ? learningError.message : String(learningError) } });
        }
      }
    } catch (error) {
      graph.update(task.id, { error: error instanceof Error ? error.message : String(error) });
      graph.setStatus(task.id, 'failed');
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.agents.recordOutcome(agent.id, { taskType: request.taskType, domain: 'general', success: false, quality: 0, latencyMs: Date.now() - taskStarted, tokens: 0 });
      await this.events.append({ type: 'task.failed', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { error: errorMessage } });
      const learningInput = { executionId: execution.id, taskId: task.id, taskType: request.taskType, agentId: agent.id, capabilities: request.requiredCapabilities, success: false, quality: 0, executionTimeMs: Date.now() - taskStarted, attempts: task.attempts + 1, error: errorMessage };
      if (this.learningAsync) {
        this.learning.enqueueFailure(learningInput);
        await this.events.append({ type: 'learning.outcome.queued', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { success: false, pendingWrites: this.learning.pendingWrites } });
      } else {
        try {
          const learned = await this.learning.recordFailure(learningInput);
          await this.events.append({ type: 'learning.outcome.recorded', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { success: false, memoryIds: learned.map((entry) => entry.id) } });
        } catch (learningError) {
          await this.events.append({ type: 'learning.persistence.failed', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { error: learningError instanceof Error ? learningError.message : String(learningError) } });
        }
      }
    } finally {
      if (lease) this.scheduler.release(lease.id);
      this.agents.setStatus(agent.id, 'idle');
    }
  }

  private rebuild(event: EventEnvelope): void {
    if (event.type === 'execution.started') {
      const payload = event.payload as { execution: ExecutionRecord };
      if (payload.execution) this.executions.set(payload.execution.id, structuredClone(payload.execution));
      return;
    }
    if (!event.executionId) return;
    const execution = this.executions.get(event.executionId);
    if (event.type === 'task.created') {
      const task = event.payload as TaskRecord;
      const existing = this.graphs.get(event.executionId)?.all() ?? [];
      this.graphs.set(event.executionId, new TaskGraph([...existing, task]));
      return;
    }
    if (!execution) return;
    const graph = this.graphs.get(event.executionId);
    if (event.type === 'execution.paused' || event.type === 'execution.resumed' || event.type === 'execution.cancelled' || event.type === 'execution.completed' || event.type === 'execution.failed') {
      const payload = event.payload as { execution?: ExecutionRecord };
      if (payload.execution) this.executions.set(event.executionId, structuredClone(payload.execution));
      return;
    }
    if (!graph || !event.taskId) return;
    if (event.type === 'task.started') {
      const payload = event.payload as { task?: TaskRecord };
      graph.update(event.taskId, { ...(event.agentId ? { assignedAgentId: event.agentId } : {}), attempts: (payload.task?.attempts ?? graph.get(event.taskId).attempts) });
      graph.setStatus(event.taskId, 'running');
    } else if (event.type === 'task.completed') {
      const payload = event.payload as { result?: unknown };
      graph.update(event.taskId, { result: payload.result });
      graph.setStatus(event.taskId, 'completed');
    } else if (event.type === 'task.failed') {
      const payload = event.payload as { error?: string };
      if (payload.error) graph.update(event.taskId, { error: payload.error });
      graph.setStatus(event.taskId, 'failed');
    }
  }

  private requireExecution(executionId: string): ExecutionRecord {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Unknown execution: ${executionId}`);
    return execution;
  }

  private requireGraph(executionId: string): TaskGraph {
    const graph = this.graphs.get(executionId);
    if (!graph) throw new Error(`Unknown execution graph: ${executionId}`);
    return graph;
  }
}

function stringInput(input: Record<string, unknown>, key: string, fallback?: string): string { const value = input[key]; if (typeof value === 'string' && value.trim()) return value; if (fallback !== undefined) return fallback; throw new Error(`MCP input requires ${key}`); }
function arrayInput(input: Record<string, unknown>, key: string): string[] { const value = input[key]; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }

export { DEFAULT_BUDGET };
