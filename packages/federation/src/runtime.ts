import { timestamp } from '../../core/src/index.js';
import type { FederatedOutcomeLearningInput, FederatedRuntimeTaskInput, HelixRuntime } from '../../runtime/src/index.js';
import type { FederationExecutionOutcome, FederationRuntimeOptions, FederationNodeRuntimeState, FederationNodeRuntimeStatus, FederationTaskPayload, FederationMessage } from './types.js';
import type { FederationCoordinator } from './coordinator.js';

export interface FederationNodeRuntimeOptionsWithRuntime extends FederationRuntimeOptions {
  runtime: Pick<HelixRuntime, 'executeFederatedTask' | 'cancelFederatedTask' | 'recordFederatedOutcome'>;
  coordinator: FederationCoordinator;
}

export class FederationNodeRuntime {
  readonly nodeId: string;
  private readonly runtime: FederationNodeRuntimeOptionsWithRuntime['runtime'];
  private readonly coordinator: FederationCoordinator;
  private readonly heartbeatIntervalMs: number;
  private readonly drainDeadlineMs: number;
  private readonly executionTimeoutMs: number;
  private state: FederationNodeRuntimeState = 'created';
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly active = new Map<string, Promise<FederationExecutionOutcome>>();
  private readonly controllers = new Map<string, AbortController>();
  private lastHeartbeat = timestamp();

  constructor(options: FederationNodeRuntimeOptionsWithRuntime) {
    this.runtime = options.runtime;
    this.coordinator = options.coordinator;
    this.nodeId = this.coordinator.localNodeId;
    this.heartbeatIntervalMs = Math.max(10, options.heartbeatIntervalMs ?? 5_000);
    this.drainDeadlineMs = Math.max(1, options.drainDeadlineMs ?? 30_000);
    this.executionTimeoutMs = Math.max(1, options.executionTimeoutMs ?? 60_000);
  }

  get currentState(): FederationNodeRuntimeState { return this.state; }

  async start(): Promise<FederationNodeRuntimeStatus> {
    if (this.state === 'ready') return this.status();
    if (!['created', 'stopped'].includes(this.state)) throw new Error(`cannot start node runtime from ${this.state}`);
    this.state = 'starting';
    try {
      this.coordinator.setTaskHandler((payload, message) => this.handleTask(payload, message));
      this.coordinator.setCancelHandler((taskId) => this.handleCancel(taskId));
      this.coordinator.heartbeat(this.nodeId);
      this.lastHeartbeat = timestamp();
      this.heartbeatTimer = setInterval(() => {
        try { this.coordinator.heartbeat(this.nodeId); this.lastHeartbeat = timestamp(); }
        catch { this.state = 'failed'; }
      }, this.heartbeatIntervalMs);
      this.state = 'ready';
      return this.status();
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  async stop(): Promise<FederationNodeRuntimeStatus> {
    if (this.state === 'stopped') return this.status();
    if (!['ready', 'draining'].includes(this.state)) throw new Error(`cannot stop node runtime from ${this.state}`);
    this.state = 'draining';
    this.coordinator.drainNode(this.nodeId);
    const deadline = Date.now() + this.drainDeadlineMs;
    while (this.active.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled(this.active.values()), new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))]);
    }
    for (const taskId of this.active.keys()) {
      this.controllers.get(taskId)?.abort();
      await this.runtime.cancelFederatedTask(taskId);
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.state = 'stopped';
    try { this.coordinator.registry.markOffline(this.nodeId); } catch { /* already offline or removed */ }
    return this.status();
  }

  status(): FederationNodeRuntimeStatus {
    const outbox = this.coordinator.outboxStatus();
    return { nodeId: this.nodeId, state: this.state, activeTasks: this.active.size, acceptingTasks: this.state === 'ready', lastHeartbeat: this.lastHeartbeat, outboxPending: outbox.pending, deadLetters: outbox.deadLetters };
  }

  private async handleTask(payload: FederationTaskPayload, message: FederationMessage): Promise<void> {
    const taskId = String(payload.taskId);
    if (this.state !== 'ready') { await this.coordinator.rejectTask(taskId, 'node runtime is not accepting tasks'); return; }
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const input: FederatedRuntimeTaskInput = {
      taskId,
      title: payload.title ?? `Federated task ${taskId}`,
      ...(typeof payload.input === 'string' ? { description: payload.input } : payload.title ? { description: payload.title } : {}),
      ...(payload.title ? { goal: payload.title } : {}),
      requiredCapabilities: [...payload.requiredCapabilities],
      ...(payload.sandbox ? { sandbox: structuredClone(payload.sandbox) } : {}),
      priority: payload.priority,
      correlationId: payload.correlationId,
      traceId: payload.traceId,
      securityContext: structuredClone(payload.securityContext),
      authorizationContext: { ...payload.authorizationContext, sourceNodeId: message.sourceNodeId, nodeId: this.nodeId },
      executionTimeoutMs: this.executionTimeoutMs,
      signal: controller.signal,
    };
    const promise = this.executeTask(input, message, controller);
    this.active.set(taskId, promise);
    try { await promise; } finally { this.active.delete(taskId); this.controllers.delete(taskId); }
  }

  private async executeTask(input: FederatedRuntimeTaskInput, message: FederationMessage, controller: AbortController): Promise<FederationExecutionOutcome> {
    await this.coordinator.start(input.taskId);
    let outcome: FederationExecutionOutcome;
    try {
      outcome = await this.runtime.executeFederatedTask(input);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      outcome = { taskId: input.taskId, attemptId: `${input.taskId}:runtime-error`, nodeId: this.nodeId, status: 'failed', error: errorMessage, startedAt: timestamp(), completedAt: timestamp(), provenance: { sourceNodeId: message.sourceNodeId, taskId: input.taskId, attemptId: `${input.taskId}:runtime-error`, timestamp: timestamp() } };
    }
    if (outcome.provenance.agentId) { const learning: FederatedOutcomeLearningInput = { executionId: input.authorizationContext.executionId ?? `federated:${message.correlationId}`, taskId: input.taskId, taskType: input.title.toLowerCase().replaceAll(' ', '-'), agentId: outcome.provenance.agentId, sourceNodeId: message.sourceNodeId, attemptId: outcome.attemptId, capabilities: [...input.requiredCapabilities], success: outcome.status === 'completed', quality: outcome.status === 'completed' ? 0.75 : 0, executionTimeMs: Math.max(0, Date.parse(outcome.completedAt) - Date.parse(outcome.startedAt)), ...(outcome.output !== undefined ? { output: outcome.output } : {}), ...(outcome.error ? { error: outcome.error } : {}) }; await this.runtime.recordFederatedOutcome(learning); }
    if (controller.signal.aborted || outcome.status === 'cancelled') await this.coordinator.completeCancelled(input.taskId, outcome.error ?? 'federated task cancelled', outcome.timeout);
    else await this.coordinator.complete(input.taskId, outcome.status === 'completed', outcome.error, outcome.output, outcome.timeout);
    return outcome;
  }

  private async handleCancel(taskId: string): Promise<void> {
    this.controllers.get(taskId)?.abort();
    await this.runtime.cancelFederatedTask(taskId);
  }
}
