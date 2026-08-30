import { join } from 'node:path';
import { AgentRegistry } from '../../agents/src/index.js';
import { EventStore } from '../../durable/src/index.js';
import { DEFAULT_BUDGET, EventEnvelope, ExecutionInput, ExecutionRecord, ResourceUsage, StructuredDecision, TaskRecord, ToolRequest, id, timestamp, withDefaultBudget } from '../../core/src/index.js';
import { defaultPlan, DeterministicFailureReplanner, ReplanProposal, RuntimeReplanner, TaskGraph } from '../../planner/src/index.js';
import { AgentRouter, RoutingCandidate } from '../../router/src/index.js';
import { PolicyEngine, secureDefaultRules } from '../../policy/src/index.js';
import { LeaseScheduler } from '../../scheduler/src/index.js';
import { MemoryQuery, MemoryRecord, MemoryStore } from '../../memory/src/index.js';
import { Telemetry } from '../../observability/src/index.js';

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
  memory?: MemoryStore;
  telemetry?: Telemetry;
  replanner?: RuntimeReplanner;
  maxReplans?: number;
}

export interface ExecutionView {
  execution: ExecutionRecord;
  tasks: TaskRecord[];
  events: EventEnvelope[];
  planRevision: number;
}

export class HelixRuntime {
  readonly events: EventStore;
  readonly agents: AgentRegistry;
  readonly router: AgentRouter;
  readonly policy: PolicyEngine;
  readonly scheduler: LeaseScheduler;
  readonly provider: ModelProvider;
  readonly memory: MemoryStore;
  readonly telemetry: Telemetry;
  readonly replanner: RuntimeReplanner;
  readonly maxReplans: number;
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly graphs = new Map<string, TaskGraph>();
  private readonly planRevisions = new Map<string, number>();
  private initialized = false;

  constructor(options: RuntimeOptions) {
    const maxReplans = options.maxReplans ?? 2;
    if (!Number.isInteger(maxReplans) || maxReplans < 0) throw new Error('maxReplans must be a non-negative integer');
    this.events = new EventStore({ directory: options.dataDirectory });
    this.agents = options.agents ?? new AgentRegistry();
    this.router = options.router ?? new AgentRouter();
    this.policy = options.policy ?? new PolicyEngine(secureDefaultRules);
    this.scheduler = options.scheduler ?? new LeaseScheduler({ stateFile: join(options.dataDirectory, 'helix.leases.json') });
    this.provider = options.provider ?? new DeterministicProvider();
    this.memory = options.memory ?? new MemoryStore(options.dataDirectory);
    this.telemetry = options.telemetry ?? new Telemetry();
    this.replanner = options.replanner ?? new DeterministicFailureReplanner();
    this.maxReplans = maxReplans;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.events.init();
    await this.memory.init();
    for (const event of await this.events.read()) this.rebuild(event);
    this.initialized = true;
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
    this.planRevisions.set(execution.id, 0);
    await this.events.append({ type: 'execution.started', executionId: execution.id, payload: { execution, idempotencyKey: `execution:${execution.id}:started` }, idempotencyKey: `execution:${execution.id}:started` });
    for (const task of tasks) await this.events.append({ type: 'task.created', executionId: execution.id, taskId: task.id, payload: task, idempotencyKey: `task:${task.id}:created` });
    await this.events.append({ type: 'plan.created', executionId: execution.id, payload: { taskIds: execution.taskIds, criticalPathMs: graph.criticalPathMs() } });
    await this.runExecution(execution.id);
    const completed = this.executions.get(execution.id)!;
    this.telemetry.endSpan(executionSpan, completed.status === 'failed' ? 'error' : 'ok', completed.error);
    this.telemetry.recordMetric('helix.execution.completed', 1, { status: completed.status, provider: this.provider.name });
    return structuredClone(completed);
  }

  async remember(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    await this.init();
    return this.memory.store(input);
  }

  async recall(query: MemoryQuery) {
    await this.init();
    return this.memory.search(query);
  }

  telemetrySnapshot() {
    return this.telemetry.snapshot();
  }

  async view(executionId: string): Promise<ExecutionView> {
    await this.init();
    const execution = this.executions.get(executionId);
    const graph = this.graphs.get(executionId);
    if (!execution || !graph) throw new Error(`Unknown execution: ${executionId}`);
    return {
      execution: structuredClone(execution),
      tasks: graph.all(),
      events: await this.events.read((event) => event.executionId === executionId),
      planRevision: this.planRevisions.get(executionId) ?? 0,
    };
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
        const failedBeforeBatch = graph.all().filter((task) => task.status === 'failed');
        if (failedBeforeBatch.length) {
          const repaired = await this.repairFailedTasks(execution, graph, failedBeforeBatch);
          if (!repaired) break;
          if (Date.now() - started > execution.budget.maxRuntimeMs) throw new Error('Execution exceeded runtime budget');
          continue;
        }

        const ready = graph.ready();
        if (!ready.length) {
          if (graph.all().some((task) => task.status === 'running')) break;
          throw new Error('Execution stalled: no ready tasks and incomplete graph');
        }
        await Promise.all(ready.map((task) => this.runTask(execution, graph, task)));
        if (Date.now() - started > execution.budget.maxRuntimeMs) throw new Error('Execution exceeded runtime budget');
      }
      if (execution.status !== 'running') return;

      const remainingFailures = graph.all().filter((task) => task.status === 'failed');
      if (remainingFailures.length) {
        const repaired = await this.repairFailedTasks(execution, graph, remainingFailures);
        if (repaired) return this.runExecution(executionId);
      }

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

  private async repairFailedTasks(execution: ExecutionRecord, graph: TaskGraph, failedTasks: TaskRecord[]): Promise<boolean> {
    let repairedAny = false;
    for (const failedTask of failedTasks) {
      if (graph.get(failedTask.id).status !== 'failed') continue;
      const revision = this.planRevisions.get(execution.id) ?? 0;
      if (revision >= this.maxReplans) {
        await this.rejectReplan(execution.id, failedTask.id, `maxReplans limit reached at revision ${revision}`);
        return false;
      }

      const remainingTaskCapacity = Math.max(0, execution.budget.maxTasks - graph.all().length);
      let proposal: ReplanProposal | null;
      try {
        proposal = await this.replanner.replan({
          execution: structuredClone(execution),
          failedTask: graph.get(failedTask.id),
          tasks: graph.all(),
          revision,
          remainingTaskCapacity,
          failureReason: graph.get(failedTask.id).error ?? 'unknown task failure',
        });
      } catch (error) {
        await this.rejectReplan(execution.id, failedTask.id, `replanner error: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }

      const proposalError = validateReplanProposal(proposal);
      if (proposalError) {
        await this.rejectReplan(execution.id, failedTask.id, proposalError);
        return false;
      }
      if (graph.all().length + proposal!.replacements.length > execution.budget.maxTasks) {
        await this.rejectReplan(execution.id, failedTask.id, 'replan would exceed maxTasks budget');
        return false;
      }

      let supersession: ReturnType<TaskGraph['supersedeFailed']>;
      try {
        supersession = graph.supersedeFailed(failedTask.id, proposal!.replacements, execution.id);
      } catch (error) {
        await this.rejectReplan(execution.id, failedTask.id, `invalid replan: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }

      const nextRevision = revision + 1;
      const currentTasks = graph.all();
      execution.taskIds = currentTasks.map((task) => task.id);
      execution.usage.tasks = currentTasks.length;
      execution.updatedAt = timestamp();

      await this.events.append({
        type: 'task.superseded',
        executionId: execution.id,
        taskId: failedTask.id,
        payload: {
          superseded: supersession.superseded,
          replacementIds: supersession.replacements.map((task) => task.id),
          reason: proposal!.reason,
        },
      });
      for (const replacement of supersession.replacements) {
        await this.events.append({
          type: 'task.created',
          executionId: execution.id,
          taskId: replacement.id,
          payload: replacement,
          idempotencyKey: `task:${replacement.id}:created`,
        });
      }
      await this.events.append({
        type: 'plan.replanned',
        executionId: execution.id,
        payload: {
          revision: nextRevision,
          failedTaskId: failedTask.id,
          replacementIds: supersession.replacements.map((task) => task.id),
          reason: proposal!.reason,
          tasks: currentTasks,
        },
      });
      this.planRevisions.set(execution.id, nextRevision);
      this.telemetry.recordMetric('helix.plan.replanned', 1, { provider: this.provider.name });
      repairedAny = true;
    }
    return repairedAny && graph.all().every((task) => task.status !== 'failed');
  }

  private async rejectReplan(executionId: string, failedTaskId: string, reason: string): Promise<void> {
    await this.events.append({
      type: 'plan.replan_rejected',
      executionId,
      taskId: failedTaskId,
      payload: { failedTaskId, reason, revision: this.planRevisions.get(executionId) ?? 0 },
    });
  }

  private async runTask(execution: ExecutionRecord, graph: TaskGraph, task: TaskRecord): Promise<void> {
    const request = { taskType: task.title.toLowerCase().replaceAll(' ', '-'), requiredCapabilities: ['analysis'], complexity: 0.5, maxCostUsd: execution.budget.maxCostUsd };
    const candidates: RoutingCandidate[] = this.agents.list().map((agent) => ({ agent, estimatedCostUsd: 0, availability: agent.status === 'idle' ? 1 : 0.5, memoryRelevance: 0.5 }));
    const route = this.router.route(request, candidates, 'adaptive');
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
      const result = await this.provider.execute({ goal: execution.goal, task, agent: agent.name });
      execution.usage.tokens += result.tokens;
      execution.usage.costUsd += result.costUsd;
      if (execution.usage.tokens > execution.budget.maxTokens || execution.usage.costUsd > execution.budget.maxCostUsd) throw new Error('Execution exceeded token or cost budget');
      graph.update(task.id, { result: result.output });
      graph.setStatus(task.id, 'completed');
      this.agents.recordOutcome(agent.id, { taskType: request.taskType, domain: 'general', success: true, quality: result.quality, latencyMs: 0, tokens: result.tokens, costUsd: result.costUsd });
      await this.events.append({ type: 'task.completed', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { result: result.output, evaluation: { success: true, quality: result.quality, provider: this.provider.name } } });
    } catch (error) {
      graph.update(task.id, { error: error instanceof Error ? error.message : String(error) });
      graph.setStatus(task.id, 'failed');
      this.agents.recordOutcome(agent.id, { taskType: request.taskType, domain: 'general', success: false, quality: 0, latencyMs: 0, tokens: 0 });
      await this.events.append({ type: 'task.failed', executionId: execution.id, taskId: task.id, agentId: agent.id, payload: { error: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (lease) this.scheduler.release(lease.id);
      this.agents.setStatus(agent.id, 'idle');
    }
  }

  private rebuild(event: EventEnvelope): void {
    if (event.type === 'execution.started') {
      const payload = event.payload as { execution: ExecutionRecord };
      if (payload.execution) {
        this.executions.set(payload.execution.id, structuredClone(payload.execution));
        this.planRevisions.set(payload.execution.id, 0);
      }
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
    let graph = this.graphs.get(event.executionId);
    if (event.type === 'execution.paused' || event.type === 'execution.resumed' || event.type === 'execution.cancelled' || event.type === 'execution.completed' || event.type === 'execution.failed') {
      const payload = event.payload as { execution?: ExecutionRecord };
      if (payload.execution) this.executions.set(event.executionId, structuredClone(payload.execution));
      return;
    }
    if (event.type === 'plan.replanned') {
      const payload = event.payload as { revision?: number; tasks?: TaskRecord[] };
      if (Array.isArray(payload.tasks)) {
        this.graphs.set(event.executionId, new TaskGraph(payload.tasks));
        graph = this.graphs.get(event.executionId);
      }
      if (Number.isInteger(payload.revision) && (payload.revision ?? -1) >= 0) this.planRevisions.set(event.executionId, payload.revision!);
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
    } else if (event.type === 'task.superseded') {
      graph.setStatus(event.taskId, 'skipped');
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

function validateReplanProposal(proposal: ReplanProposal | null): string | undefined {
  if (!proposal) return 'replanner declined repair';
  if (typeof proposal.reason !== 'string' || !proposal.reason.trim()) return 'replan reason is required';
  if (!Array.isArray(proposal.replacements) || !proposal.replacements.length) return 'replan requires at least one replacement task';
  for (const replacement of proposal.replacements) {
    if (!replacement || typeof replacement !== 'object') return 'replan contains an invalid replacement task';
    if (typeof replacement.title !== 'string' || !replacement.title.trim()) return 'replacement task title is required';
    if (typeof replacement.description !== 'string' || !replacement.description.trim()) return 'replacement task description is required';
    if (replacement.estimatedMs !== undefined && (!Number.isFinite(replacement.estimatedMs) || replacement.estimatedMs <= 0)) return 'replacement task estimatedMs must be greater than zero';
  }
  return undefined;
}

export { DEFAULT_BUDGET };