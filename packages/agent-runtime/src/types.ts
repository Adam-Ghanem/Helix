import type { AgentProfile } from '../../core/src/index.js';
import type { ModelProvider, ProviderResult } from '../../runtime/src/index.js';
import type { ToolSchema } from '../../tools/src/index.js';

export type AgentDecision =
  | { type: 'tool_call'; toolName: string; arguments: Record<string, unknown> }
  | { type: 'final'; content: string };

export interface AgentProviderInput {
  goal: string;
  task: { id: string; title: string; description: string };
  agent: AgentProfile;
  context: AgentContext;
  tools: AgentToolDefinition[];
  iteration: number;
  signal?: AbortSignal;
}

export interface AgentProviderResponse {
  decision: AgentDecision;
  usage?: { tokens?: number; costUsd?: number; model?: string };
  rawOutput?: unknown;
}

export type StructuredAgentProvider = ModelProvider & { executeAgent(input: AgentProviderInput): Promise<AgentProviderResponse> };

export type AgentToolCategory = 'READ' | 'WRITE' | 'EXECUTE' | 'NETWORK' | 'ADMIN';
export type AgentToolRisk = 'low' | 'medium' | 'high';

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  risk: AgentToolRisk;
  category: AgentToolCategory;
  permissions: string[];
  timeoutMs?: number;
  metadata?: Record<string, string>;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  agentId: string;
  taskId: string;
  executionId: string;
  iteration: number;
  signal: AbortSignal;
}

export interface AgentBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxExecutionTimeMs: number;
  maxProviderCalls: number;
  maxTokens: number;
  maxCostUsd: number;
  maxMemoryRecalls: number;
  maxPolicyDenials: number;
  repeatedToolCallLimit: number;
}

export interface BudgetStatus {
  startedAt: string;
  elapsedMs: number;
  iterations: number;
  toolCalls: number;
  providerCalls: number;
  tokens: number;
  costUsd: number;
  memoryRecalls: number;
  policyDenials: number;
  remaining: AgentBudget;
  warnings: string[];
  exceeded: string[];
}

export interface AgentRuntimeConfig extends Partial<AgentBudget> {
  signal?: AbortSignal;
  noMemory?: boolean;
}

export interface AgentTaskInput {
  taskId: string;
  executionId: string;
  goal: string;
  title: string;
  description: string;
  agentId: string;
  sessionId?: string;
  swarmId?: string;
  signal?: AbortSignal;
  config?: AgentRuntimeConfig;
  metadata?: Record<string, unknown>;
}

export interface AgentContext {
  task: { id: string; title: string; description: string };
  agent: AgentProfile;
  memories: Array<{ id: string; content: string; explanation?: string; confidence?: number }>;
  tools: AgentToolDefinition[];
  history: AgentMessage[];
  metadata: Record<string, unknown>;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface ToolCallRecord {
  toolCallId: string;
  iteration: number;
  agentId: string;
  taskId: string;
  executionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  risk: AgentToolRisk;
  category: AgentToolCategory;
  authorization: { allowed: boolean; reason: string; approvalId?: string };
  status: 'completed' | 'failed' | 'denied' | 'timeout' | 'cancelled';
  result?: unknown;
  error?: string;
}

export type AgentExecutionStatus = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'budget_exceeded' | 'policy_denied';

export interface AgentExecutionResult {
  executionId: string;
  taskId: string;
  agentId: string;
  status: AgentExecutionStatus;
  output?: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  durationMs: number;
  provider: string;
  model?: string;
  usage?: { tokens: number; costUsd: number };
  memoriesRecalled: number;
  memoriesCreated: number;
  errors: string[];
  traceId: string;
  budget: BudgetStatus;
}

export interface AgentRuntimeHost {
  provider: ModelProvider;
  agents: { get(id: string): AgentProfile };
  recallMemory(input: { query: string; agentId: string; taskId: string; sessionId?: string; limit: number }): Promise<Array<{ id: string; content: string; explanation?: string; confidence?: number }>>;
  recordLearning(input: { executionId: string; taskId: string; taskType: string; agentId: string; capabilities: string[]; success: boolean; quality: number; executionTimeMs: number; attempts: number; output?: unknown; error?: string; sessionId?: string; swarmId?: string; metadata?: Record<string, string | number | boolean | null> }): Promise<number>;
  requestTool(request: { id: string; executionId: string; agentId: string; tool: string; input: Record<string, unknown>; risk: 'low' | 'medium' | 'high' }): Promise<{ allowed: boolean; reason: string; approvalId?: string }>;
  appendEvent(event: { type: string; executionId?: string; taskId?: string; agentId?: string; correlationId?: string; payload?: unknown }): Promise<void>;
}

export function defaultAgentBudget(input: AgentRuntimeConfig = {}): AgentBudget {
  return {
    maxIterations: Math.max(1, Math.floor(input.maxIterations ?? 12)),
    maxToolCalls: Math.max(0, Math.floor(input.maxToolCalls ?? 20)),
    maxExecutionTimeMs: Math.max(1, Math.floor(input.maxExecutionTimeMs ?? input.maxExecutionTimeMs ?? 60_000)),
    maxProviderCalls: Math.max(1, Math.floor(input.maxProviderCalls ?? 12)),
    maxTokens: Math.max(0, Math.floor(input.maxTokens ?? 100_000)),
    maxCostUsd: Math.max(0, input.maxCostUsd ?? 10),
    maxMemoryRecalls: Math.max(0, Math.floor(input.maxMemoryRecalls ?? 1)),
    maxPolicyDenials: Math.max(0, Math.floor(input.maxPolicyDenials ?? 3)),
    repeatedToolCallLimit: Math.max(1, Math.floor(input.repeatedToolCallLimit ?? 2)),
  };
}

export function providerName(provider: ModelProvider): string { return provider.name; }
export function isStructuredProvider(provider: ModelProvider): provider is StructuredAgentProvider { return typeof (provider as Partial<StructuredAgentProvider>).executeAgent === 'function'; }
export type AgentProviderResult = ProviderResult;
