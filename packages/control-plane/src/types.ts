import type { AgentProfile } from '../../core/src/index.js';
import type { ExecutionRecord, EventEnvelope, TaskRecord } from '../../core/src/index.js';
import type { FederationNode, FederationStatus } from '../../federation/src/index.js';
import type { ProviderModel } from '../../providers/src/index.js';

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricSnapshot {
  name: string;
  kind: MetricKind;
  value: number | HistogramSnapshot;
  labels: Record<string, string>;
  updatedAt: string;
}

export interface MetricsSnapshot {
  generatedAt: string;
  metrics: MetricSnapshot[];
}

export type ControlEventType =
  | 'agent.created' | 'agent.started' | 'agent.stopped' | 'agent.failed'
  | 'task.created' | 'task.queued' | 'task.assigned' | 'task.started' | 'task.completed' | 'task.failed' | 'task.retried' | 'task.reassigned'
  | 'worker.started' | 'worker.completed' | 'worker.failed' | 'worker.timeout' | 'worker.cancelled'
  | 'swarm.created' | 'swarm.started' | 'swarm.completed' | 'swarm.failed' | 'swarm.rebalanced' | 'swarm.topology.changed'
  | 'node.joined' | 'node.heartbeat' | 'node.unhealthy' | 'node.offline' | 'node.recovered'
  | 'execution.started' | 'execution.completed' | 'execution.failed' | 'execution.cancelled'
  | 'memory.created' | 'memory.recalled' | 'learning.updated'
  | 'sandbox.started' | 'sandbox.completed' | 'sandbox.denied'
  | 'provider.started' | 'provider.completed' | 'provider.failed'
  | 'security.denied' | 'policy.denied' | 'federation.auth_failed' | 'federation.replay_rejected'
  | (string & {});

export interface ControlEvent<T = Record<string, unknown>> {
  eventId: string;
  type: ControlEventType;
  timestamp: string;
  correlationId?: string;
  causationId?: string;
  actor?: string;
  source?: string;
  executionId?: string;
  taskId?: string;
  agentId?: string;
  metadata: T;
}

export interface ExecutionTraceStage {
  name: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

export interface ExecutionTraceDecision {
  name: string;
  selected: string;
  rationale: string[];
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface ExecutionTrace {
  executionId: string;
  goalId?: string;
  taskId?: string;
  swarmId?: string;
  agentId?: string;
  nodeId?: string;
  parentExecutionId?: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stages: ExecutionTraceStage[];
  decisions: ExecutionTraceDecision[];
  events: ControlEvent[];
  errors: string[];
  metrics: Record<string, number>;
}

export interface WorkerSnapshot {
  id: string;
  status: 'idle' | 'busy' | 'offline';
  taskId?: string;
  leaseId?: string;
  utilization: number;
}

export interface QueueSnapshot {
  depth: number;
  activeLeases: number;
  leases: Array<{ id: string; taskId: string; workerId: string; expiresAt: number }>;
}

export interface MemorySnapshot {
  total: number;
  namespaces: Record<string, number>;
  cacheSize: number;
  lastLookupMs?: number;
}

export interface PolicySnapshot {
  mode: 'default-deny';
  denials: number;
  approvals: number;
  lastDecision?: string;
}

export interface ControlPlaneSnapshot {
  generatedAt: string;
  agents: AgentProfile[];
  tasks: TaskRecord[];
  workers: WorkerSnapshot[];
  swarms: Array<Record<string, unknown>>;
  nodes: FederationNode[];
  executions: ExecutionRecord[];
  queue: QueueSnapshot;
  memory: MemorySnapshot;
  policies: PolicySnapshot;
  federation: FederationStatus;
  metrics: MetricsSnapshot;
}

export interface ControlPlaneHealthCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  details?: Record<string, unknown>;
}

export interface ControlPlaneHealth {
  status: 'PASS' | 'WARN' | 'FAIL';
  checkedAt: string;
  checks: ControlPlaneHealthCheck[];
}

export interface ProviderHealth {
  id: string;
  name: string;
  available: boolean;
  configured: boolean;
  latencyMs?: number;
  message: string;
}

export interface ModelRouteRequest {
  capabilities: string[];
  maxLatencyMs?: number;
  maxCostUsd?: number;
  privateOnly?: boolean;
}

export interface ModelRouteDecision {
  model: ProviderModel;
  rationale: string[];
}

export interface ControlPlaneSession {
  id: string;
  goal: string;
  createdAt: string;
  status: 'created' | 'running' | 'stopped' | 'completed' | 'failed';
  topology: string;
  agents: string[];
  tasks: string[];
  executions: string[];
  memoryNamespace: string;
  startedAt?: string;
  completedAt?: string;
  failure?: string;
}

export interface SessionInput {
  goal: string;
  topology?: string;
  maxAgents?: number;
}

export interface DoctorReport {
  status: 'PASS' | 'WARN' | 'FAIL';
  generatedAt: string;
  checks: ControlPlaneHealthCheck[];
}

export type ControlPlaneEventHandler<T = ControlEvent> = (event: T) => void | Promise<void>;

export function eventFromEnvelope(envelope: EventEnvelope): ControlEvent {
  return {
    eventId: envelope.eventId,
    type: envelope.type,
    timestamp: envelope.timestamp,
    ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
    ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
    ...(envelope.executionId ? { executionId: envelope.executionId } : {}),
    ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
    ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
    metadata: envelope.payload as Record<string, unknown>,
  };
}
