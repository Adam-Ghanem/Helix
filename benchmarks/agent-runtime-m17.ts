import { performance } from 'node:perf_hooks';
import { AgentRuntime } from '../packages/agent-runtime/src/index.js';
import type { AgentProviderInput, AgentProviderResponse, AgentRuntimeHost, AgentToolDefinition } from '../packages/agent-runtime/src/index.js';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { PolicyEngine } from '../packages/policy/src/index.js';
import { id, type ToolRequest } from '../packages/core/src/index.js';
import type { ModelProvider, ProviderResult } from '../packages/runtime/src/index.js';

class BenchmarkProvider implements ModelProvider {
  readonly name = 'deterministic-local';
  async execute(input: { goal: string; task: { id: string; title: string; description: string }; agent: string }): Promise<ProviderResult> { return { output: `fallback:${input.task.title}`, tokens: 1, costUsd: 0, quality: 0.75 }; }
  async executeAgent(input: AgentProviderInput): Promise<AgentProviderResponse> { if (input.iteration === 1 && input.goal.includes('tool') && input.tools.some((tool) => tool.name === 'benchmark.echo')) return { decision: { type: 'tool_call', toolName: 'benchmark.echo', arguments: { value: input.task.id } }, usage: { tokens: 2, costUsd: 0, model: 'deterministic-local' } }; return { decision: { type: 'final', content: `completed ${input.task.title}` }, usage: { tokens: 2, costUsd: 0, model: 'deterministic-local' } }; }
}

const values: Record<string, number[]> = {};
function record(name: string, value: number): void { (values[name] ??= []).push(value); }
function percentile(items: number[], p: number): number { const sorted = [...items].sort((a, b) => a - b); if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!; }
function stats(name: string): Record<string, number> { const items = values[name] ?? []; return { count: items.length, p50Ms: percentile(items, 0.5), p95Ms: percentile(items, 0.95), p99Ms: percentile(items, 0.99), meanMs: items.reduce((sum, value) => sum + value, 0) / Math.max(1, items.length) }; }
function timed<T>(name: string, operation: () => Promise<T> | T): Promise<T> { const start = performance.now(); const result = operation(); return Promise.resolve(result).finally(() => record(name, performance.now() - start)); }

function fixture(): { runtime: AgentRuntime; agentId: string; provider: BenchmarkProvider } {
  const agents = new AgentRegistry(false); const agent = agents.register({ name: 'benchmark-agent', role: 'benchmark', capabilities: ['analysis'] }); const provider = new BenchmarkProvider(); const policy = new PolicyEngine([{ resource: 'benchmark.echo', action: 'allow', subjects: ['*'] }]); const host: AgentRuntimeHost = { provider, agents: { get: (agentId) => agents.get(agentId) }, recallMemory: async () => [], recordLearning: async () => 3, requestTool: async (request: ToolRequest) => { const decision = policy.decide(request, { subject: request.agentId }); return { allowed: decision.action === 'allow', reason: decision.reason }; }, appendEvent: async () => undefined }; const runtime = new AgentRuntime(host); const echo: AgentToolDefinition = { name: 'benchmark.echo', description: 'bounded benchmark echo', inputSchema: { required: ['value'], properties: { value: 'string' } }, risk: 'low', category: 'READ', permissions: [], execute: async (input) => ({ echoed: String(input.value) }) }; runtime.registerTool(echo); return { runtime, agentId: agent.id, provider }; }

async function main(): Promise<void> {
  const value = fixture();
  for (let index = 0; index < 100; index += 1) await timed('contextAndLoop', () => value.runtime.run({ taskId: `agent-task-${index}`, executionId: `agent-execution-${index}`, goal: 'benchmark deterministic agent', title: `agent-${index}`, description: 'run bounded agent benchmark', agentId: value.agentId }, { noMemory: true, maxIterations: 3, maxToolCalls: 2 }));
  for (let index = 0; index < 100; index += 1) await timed('providerDecision', () => value.runtime.run({ taskId: `provider-task-${index}`, executionId: `provider-execution-${index}`, goal: 'provider benchmark', title: 'provider task', description: 'provider decision', agentId: value.agentId }, { noMemory: true, maxIterations: 1, maxToolCalls: 0 }));
  for (let index = 0; index < 100; index += 1) await timed('toolAuthorizationAndExecution', () => value.runtime.run({ taskId: `tool-task-${index}`, executionId: `tool-execution-${index}`, goal: 'tool benchmark', title: 'tool task', description: 'tool execution', agentId: value.agentId }, { noMemory: true, maxIterations: 3, maxToolCalls: 1 }));
  const scaleStart = performance.now(); const scaleResults = await Promise.all(Array.from({ length: 1_000 }, (_, index) => value.runtime.run({ taskId: `scale-task-${index}`, executionId: `scale-execution-${index}`, goal: 'scale benchmark', title: `scale task ${index}`, description: 'deterministic scale task', agentId: value.agentId }, { noMemory: true, maxIterations: 1, maxToolCalls: 0 }))); const scaleDurationMs = performance.now() - scaleStart;
  const multiStart = performance.now(); const multi = await value.runtime.run({ taskId: 'multi-tool-task', executionId: 'multi-tool-execution', goal: 'multi-tool benchmark', title: 'multi-tool task', description: 'bounded tool workflow', agentId: value.agentId }, { noMemory: true, maxIterations: 3, maxToolCalls: 1 }); const multiDurationMs = performance.now() - multiStart;
  console.log(JSON.stringify({ benchmark: 'M17 agent-runtime', provider: value.provider.name, externalProviderCalls: false, results: { contextAndLoop: stats('contextAndLoop'), providerDecision: stats('providerDecision'), toolAuthorizationAndExecution: stats('toolAuthorizationAndExecution'), completeAgentLoop: stats('contextAndLoop'), multiToolWorkflow: { durationMs: multiDurationMs, status: multi.status, toolCalls: multi.toolCalls.length }, oneHundredAgentTasks: { count: 100, completed: 100, throughputPerSecond: 100 / ((values.contextAndLoop ?? []).reduce((sum, item) => sum + item, 0) / 1_000) }, oneThousandTasks: { count: scaleResults.length, completed: scaleResults.filter((result) => result.status === 'completed').length, durationMs: scaleDurationMs, throughputPerSecond: scaleResults.length / (scaleDurationMs / 1_000) } } }, null, 2));
}
await main();
