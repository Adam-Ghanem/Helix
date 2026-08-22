import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;
export type Id = string;
export type ExecutionId = Id;
export type TaskId = Id;
export type AgentId = Id;
export type EventId = Id;

export function id(prefix: string): Id {
  return `${prefix}_${randomUUID()}`;
}

export function timestamp(): string {
  return new Date().toISOString();
}

export type ExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';
export type AgentStatus = 'idle' | 'busy' | 'unhealthy' | 'offline';

export interface ResourceBudget {
  maxAgents: number;
  maxTasks: number;
  maxToolCalls: number;
  maxTokens: number;
  maxCostUsd: number;
  maxRuntimeMs: number;
  maxDelegationDepth: number;
}

export interface ResourceUsage {
  agents: number;
  tasks: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
  runtimeMs: number;
  delegationDepth: number;
}

export interface StructuredDecision {
  decision: string;
  confidence: number;
  evidence: string[];
  constraints: string[];
  selectedStrategy?: string;
}

export interface Observation {
  type: 'goal' | 'event' | 'tool-result' | 'state';
  summary: string;
  data: Record<string, unknown>;
}

export interface Action {
  type: 'dispatch-task' | 'request-tool' | 'complete' | 'fail' | 'replan';
  summary: string;
  data: Record<string, unknown>;
}

export interface Evaluation {
  success: boolean;
  quality: number;
  costUsd: number;
  latencyMs: number;
  reliability: number;
  toolEfficiency: number;
  notes: string[];
}

export interface AgentProfile {
  id: AgentId;
  name: string;
  role: string;
  capabilities: string[];
  specialization?: string;
  systemInstructions?: string;
  model?: string;
  provider?: string;
  permissions: string[];
  status: AgentStatus;
  health: AgentHealth;
  reputation: ReputationRecord[];
}

export interface AgentHealth {
  successRate: number;
  failureRate: number;
  latencyMs: number;
  tokenConsumption: number;
  toolFailures: number;
  timeouts: number;
  retries: number;
  qualityScore: number;
  samples: number;
}

export interface ReputationRecord {
  taskType: string;
  domain: string;
  score: number;
  samples: number;
  lastUpdated: string;
}

export interface TaskRecord {
  id: TaskId;
  executionId: ExecutionId;
  title: string;
  description: string;
  dependencies: TaskId[];
  status: TaskStatus;
  assignedAgentId?: AgentId;
  attempts: number;
  result?: unknown;
  error?: string;
}

export interface ExecutionRecord {
  id: ExecutionId;
  goal: string;
  status: ExecutionStatus;
  createdAt: string;
  updatedAt: string;
  taskIds: TaskId[];
  budget: ResourceBudget;
  usage: ResourceUsage;
  result?: unknown;
  error?: string;
}

export interface EventEnvelope<T = unknown> {
  eventId: EventId;
  sequence: number;
  timestamp: string;
  executionId?: ExecutionId;
  taskId?: TaskId;
  agentId?: AgentId;
  correlationId?: string;
  causationId?: EventId;
  type: string;
  payload: T;
  schemaVersion: SchemaVersion;
  idempotencyKey?: string;
}

export interface ToolRequest {
  id: Id;
  executionId: ExecutionId;
  agentId: AgentId;
  tool: string;
  input: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
}

export type PolicyAction = 'allow' | 'deny' | 'approval' | 'rate-limit' | 'audit';
export interface PolicyRule {
  resource: string;
  action: PolicyAction;
  subjects?: string[];
}

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  approvalId?: Id;
  rule?: PolicyRule;
}

export interface ApprovalRequest {
  id: Id;
  executionId: ExecutionId;
  requestedBy: AgentId;
  resource: string;
  summary: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface SandboxExecutionRequest {
  enabled: boolean;
  backend?: 'local' | 'docker';
  policy?: {
    allowedExecutables?: string[];
    allowedPaths?: string[];
    deniedPaths?: string[];
    environmentAllowlist?: string[];
    networkMode?: 'none' | 'host' | 'bridge' | 'custom';
    timeoutMs?: number;
    memoryLimitMb?: number;
    cpuLimit?: number;
    maxProcesses?: number;
    readOnlyRoot?: boolean;
    workspacePath?: string;
    containerImage?: string;
    user?: string;
    allowNetwork?: boolean;
    allowChildProcesses?: boolean;
  };
  command?: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number };
}

export interface ExecutionInput {
  goal: string;
  budget?: Partial<ResourceBudget>;
  metadata?: Record<string, unknown>;
  sandbox?: SandboxExecutionRequest;
}

export const DEFAULT_BUDGET: ResourceBudget = {
  maxAgents: 8,
  maxTasks: 64,
  maxToolCalls: 32,
  maxTokens: 100_000,
  maxCostUsd: 10,
  maxRuntimeMs: 15 * 60_000,
  maxDelegationDepth: 3,
};

export function withDefaultBudget(input?: Partial<ResourceBudget>): ResourceBudget {
  return { ...DEFAULT_BUDGET, ...input };
}
