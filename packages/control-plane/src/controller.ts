import { timestamp } from '../../core/src/index.js';
import type { HelixRuntime } from '../../runtime/src/index.js';
import type { ExecutionRecord } from '../../core/src/index.js';
import { EventBus } from './event-bus.js';
import { MetricsRegistry } from './metrics.js';
import { ExecutionTraceStore } from './trace.js';
import { SessionManager } from './sessions.js';
import { Doctor } from './doctor.js';
import { ModelRouter, ProviderCatalog, RuntimeProviderAdapter } from './providers.js';
import { ProviderRegistry } from '../../providers/src/index.js';
import { eventFromEnvelope, type ControlPlaneHealthCheck, type ControlPlaneSnapshot, type MemorySnapshot, type PolicySnapshot, type QueueSnapshot, type WorkerSnapshot } from './types.js';

export interface ControlPlaneOptions {
  metrics?: MetricsRegistry;
  events?: EventBus;
  traces?: ExecutionTraceStore;
  eventHistoryLimit?: number;
}

export class ControlPlaneController {
  readonly metrics: MetricsRegistry;
  readonly events: EventBus;
  readonly traces: ExecutionTraceStore;
  readonly sessions: SessionManager;
  readonly doctor: Doctor;
  readonly providers: ProviderCatalog;
  readonly models: ProviderRegistry;
  readonly modelRouter: ModelRouter;
  private readonly eventHistoryLimit: number;
  private lastEventSequence = 0;

  constructor(readonly runtime: HelixRuntime, options: ControlPlaneOptions = {}) {
    this.metrics = options.metrics ?? new MetricsRegistry();
    this.events = options.events ?? new EventBus({ maxHistory: options.eventHistoryLimit ?? 2_000 });
    this.traces = options.traces ?? new ExecutionTraceStore();
    this.sessions = new SessionManager(runtime);
    this.doctor = new Doctor(runtime);
    this.providers = new ProviderCatalog();
    this.providers.register(new RuntimeProviderAdapter(runtime.provider));
    this.models = new ProviderRegistry();
    this.models.register({ id: `runtime:${runtime.provider.name}`, provider: runtime.provider.name, capabilities: ['text-generation', 'analysis'], contextWindow: 128_000, inputCostPerMillion: 0, outputCostPerMillion: 0, latencyMs: 1_000, available: true });
    this.modelRouter = new ModelRouter(this.models, this.providers);
    this.eventHistoryLimit = options.eventHistoryLimit ?? 2_000;
  }

  async snapshot(): Promise<ControlPlaneSnapshot> {
    await this.runtime.init();
    await this.syncEvents();
    const agents = this.runtime.agents.list();
    const tasks = this.runtime.listTasks();
    const executions = [...this.runtime.listExecutions(), ...await this.agentExecutionProjections()];
    const leases = this.runtime.scheduler.list();
    const nodes = this.runtime.federation.listNodes();
    const federation = this.runtime.federation.status();
    const memory = await this.memorySnapshot();
    const workers: WorkerSnapshot[] = agents.map((agent) => {
      const lease = leases.find((candidate) => candidate.workerId === agent.id);
      return { id: `worker:${agent.id}`, status: agent.status === 'offline' ? 'offline' : lease ? 'busy' : 'idle', ...(lease ? { taskId: lease.taskId, leaseId: lease.id } : {}), utilization: lease ? 1 : 0 };
    });
    const queue: QueueSnapshot = { depth: tasks.filter((task) => ['pending', 'ready'].includes(task.status)).length, activeLeases: leases.length, leases: leases.map((lease) => ({ id: lease.id, taskId: lease.taskId, workerId: lease.workerId, expiresAt: lease.expiresAt })) };
    const policies = this.policySnapshot();
    this.metrics.gauge('agents.available', agents.filter((agent) => ['idle', 'busy'].includes(agent.status)).length);
    this.metrics.gauge('workers.active', workers.filter((worker) => worker.status === 'busy').length);
    this.metrics.gauge('tasks.queue_depth', queue.depth);
    this.metrics.gauge('federation.nodes_healthy', nodes.filter((node) => node.status === 'healthy').length);
    this.metrics.gauge('memory.entries', memory.total);
    return { generatedAt: timestamp(), agents, tasks, workers, swarms: this.runtime.swarms.list() as unknown as Array<Record<string, unknown>>, nodes, executions, queue, memory, policies, federation, metrics: this.metrics.snapshot() };
  }

  private async agentExecutionProjections(): Promise<ExecutionRecord[]> {
    const results = this.runtime.listAgentExecutions();
    const projections: ExecutionRecord[] = [];
    for (const result of results) {
      const lifecycle = await this.runtime.events.read((event) => event.executionId === result.executionId && event.type === 'execution.started');
      const startedAt = lifecycle[0]?.timestamp ?? new Date(Date.now() - result.durationMs).toISOString();
      const status: ExecutionRecord['status'] = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      projections.push({ id: result.executionId, goal: result.taskId, status, createdAt: startedAt, updatedAt: new Date(new Date(startedAt).getTime() + result.durationMs).toISOString(), taskIds: [result.taskId], budget: { maxAgents: 1, maxTasks: 1, maxToolCalls: result.budget.remaining.maxToolCalls, maxTokens: result.budget.remaining.maxTokens, maxCostUsd: result.budget.remaining.maxCostUsd, maxRuntimeMs: result.budget.remaining.maxExecutionTimeMs, maxDelegationDepth: 0 }, usage: { agents: 1, tasks: 1, toolCalls: result.budget.toolCalls, tokens: result.usage?.tokens ?? 0, costUsd: result.usage?.costUsd ?? 0, runtimeMs: result.durationMs, delegationDepth: 0 }, ...(result.output ? { result: { output: result.output, agentId: result.agentId, toolCalls: result.toolCalls } } : {}), ...(result.errors[0] ? { error: result.errors[0] } : {}) });
    }
    return projections;
  }

  async trace(executionId: string) { await this.syncEvents(); return this.traces.get(executionId); }
  async providerStatus() { return this.providers.health(); }
  routeModel(input: Parameters<ModelRouter['route']>[0]) { return this.modelRouter.route(input); }
  listTraces(limit = 100) { return this.traces.list(limit); }
  listEvents(options: { type?: string; since?: string; limit?: number } = {}) { return this.events.list(options as Parameters<EventBus['list']>[0]); }

  async health(): Promise<{ status: 'PASS' | 'WARN' | 'FAIL'; checkedAt: string; checks: Array<{ name: string; status: 'PASS' | 'WARN' | 'FAIL'; message: string; details?: Record<string, unknown> }> }> {
    const snapshot = await this.snapshot();
    const checks: ControlPlaneHealthCheck[] = [
      { name: 'agent-registry', status: snapshot.agents.length ? 'PASS' as const : 'WARN' as const, message: `${snapshot.agents.length} agents registered` },
      { name: 'scheduler', status: 'PASS' as const, message: `${snapshot.queue.activeLeases} active leases` },
      { name: 'workers', status: snapshot.workers.length ? 'PASS' as const : 'WARN' as const, message: `${snapshot.workers.length} worker views available` },
      { name: 'memory', status: 'PASS' as const, message: `${snapshot.memory.total} memory entries` },
      { name: 'federation', status: snapshot.federation.metrics.nodesOffline ? 'WARN' as const : 'PASS' as const, message: `${snapshot.nodes.length} federation nodes`, details: { offline: snapshot.federation.metrics.nodesOffline } },
      { name: 'policy', status: 'PASS' as const, message: 'default-deny policy boundary is active' },
    ];
    const status = checks.some((check) => check.status === 'FAIL') ? 'FAIL' : checks.some((check) => check.status === 'WARN') ? 'WARN' : 'PASS';
    return { status, checkedAt: timestamp(), checks };
  }

  async syncEvents(): Promise<void> {
    const envelopes = await this.runtime.events.read();
    for (const envelope of envelopes.slice(this.lastEventSequence, this.lastEventSequence + this.eventHistoryLimit)) {
      const event = eventFromEnvelope(envelope);
      this.events.publish({ type: event.type, metadata: event.metadata, ...(event.executionId ? { executionId: event.executionId } : {}), ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.agentId ? { agentId: event.agentId } : {}), ...(event.correlationId ? { correlationId: event.correlationId } : {}), ...(event.causationId ? { causationId: event.causationId } : {}), source: 'runtime', actor: 'helix' });
      if (event.type.endsWith('.completed')) this.metrics.counter('tasks.completed');
      if (event.type.endsWith('.failed')) this.metrics.counter('tasks.failed');
      if (event.type.includes('retry')) this.metrics.counter('tasks.retried');
      if (event.type.includes('reassign')) this.metrics.counter('tasks.reassigned');
      if (event.type === 'policy.denied' || event.type === 'security.denied') this.metrics.counter('security.denied');
      if (event.executionId) this.updateTraceFromEvent(event.executionId, event);
    }
    this.lastEventSequence = envelopes.length;
  }

  private updateTraceFromEvent(executionId: string, event: ReturnType<typeof eventFromEnvelope>): void {
    if (!this.traces.get(executionId)) this.traces.start({ executionId });
    this.traces.addEvent(executionId, event);
    const stageName = event.type.replaceAll('.', '/');
    if (event.type === 'execution.started') this.traces.addStage(executionId, { name: stageName, status: 'running', startedAt: event.timestamp, metadata: event.metadata });
    else if (event.type.endsWith('.failed')) this.traces.addStage(executionId, { name: stageName, status: 'failed', startedAt: event.timestamp, completedAt: event.timestamp, metadata: event.metadata });
    else if (event.type.endsWith('.completed')) this.traces.addStage(executionId, { name: stageName, status: 'completed', startedAt: event.timestamp, completedAt: event.timestamp, metadata: event.metadata });
    else this.traces.addStage(executionId, { name: stageName, status: 'completed', startedAt: event.timestamp, completedAt: event.timestamp, metadata: event.metadata });
    if (event.type.endsWith('.failed') || event.type === 'policy.denied' || event.type === 'security.denied') this.traces.addError(executionId, JSON.stringify(event.metadata).slice(0, 2_000));
    if (event.type === 'execution.completed') this.traces.finish(executionId, 'completed');
    if (event.type === 'execution.failed') this.traces.finish(executionId, 'failed');
    if (event.type === 'execution.cancelled') this.traces.finish(executionId, 'cancelled');
  }

  private async memorySnapshot(): Promise<MemorySnapshot> {
    const stats = await this.runtime.memoryStats();
    const statsRecord = stats as unknown as Record<string, unknown>;
    const total = typeof statsRecord.count === 'number' ? statsRecord.count : typeof statsRecord.total === 'number' ? statsRecord.total : typeof statsRecord.entries === 'number' ? statsRecord.entries : 0;
    const namespaces = statsRecord.byNamespace && typeof statsRecord.byNamespace === 'object' ? statsRecord.byNamespace as Record<string, number> : statsRecord.namespaces && typeof statsRecord.namespaces === 'object' ? statsRecord.namespaces as Record<string, number> : {};
    return { total, namespaces: { ...namespaces }, cacheSize: this.runtime.memoryCacheSize() };
  }

  private policySnapshot(): PolicySnapshot {
    const events = this.events.list({ limit: this.eventHistoryLimit });
    const denials = events.filter((event) => event.type === 'policy.denied' || event.type === 'security.denied').length;
    return { mode: 'default-deny', denials, approvals: events.filter((event) => event.type.includes('approved')).length, ...(events.at(-1) ? { lastDecision: events.at(-1)!.type } : {}) };
  }
}
