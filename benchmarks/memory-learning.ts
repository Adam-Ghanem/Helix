import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentRouter, type RoutingCandidate, type RoutingRequest } from '../packages/router/src/index.js';
import { MemoryStore } from '../packages/memory/src/index.js';
import { PersistentLearningEngine } from '../packages/learning/src/index.js';

interface BenchmarkResult {
  routingSuccessRate: number;
  taskCompletionRate: number;
  averageWaitMs: number;
  averageExecutionMs: number;
  routingStability: number;
  memoryLookupLatencyMs: number;
  memoryCount: number;
}

const AGENT_COUNT = 100;
const TASK_COUNT = 1_000;

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-m9-benchmark-'));
  try {
    const agents = new AgentRegistry(false);
    for (let index = 0; index < AGENT_COUNT; index += 1) agents.register({ name: `agent-${index}`, role: 'benchmark-worker', capabilities: capabilitiesFor(index) });
    const profiles = agents.list();
    const baseline = await runBenchmark(profiles, undefined, undefined);
    const memory = new MemoryStore(directory);
    const learning = new PersistentLearningEngine(memory);
    const learned = await runBenchmark(profiles, memory, learning);
    console.log(JSON.stringify({ agents: AGENT_COUNT, tasks: TASK_COUNT, baseline, learning: learned, deltas: { taskCompletionRate: learned.taskCompletionRate - baseline.taskCompletionRate, averageWaitMs: learned.averageWaitMs - baseline.averageWaitMs, routingStability: learned.routingStability - baseline.routingStability, memoryLookupLatencyMs: learned.memoryLookupLatencyMs } }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runBenchmark(profiles: ReturnType<AgentRegistry['list']>, memory: MemoryStore | undefined, learning: PersistentLearningEngine | undefined): Promise<BenchmarkResult> {
  const router = new AgentRouter();
  let routed = 0;
  let completed = 0;
  let waitMs = 0;
  let executionMs = 0;
  let stable = 0;
  let previousAgent: string | undefined;
  for (let index = 0; index < TASK_COUNT; index += 1) {
    const request = requestFor(index);
    const candidates: RoutingCandidate[] = profiles.map((agent) => ({ agent, estimatedCostUsd: 0, availability: 1, memoryRelevance: 0.5 }));
    const beforeRoute = performance.now();
    const scores = learning ? await learning.routingScores(request, candidates) : new Map<string, number>();
    const enriched = candidates.map((candidate) => ({ ...candidate, learningBonus: scores.get(candidate.agent.id) ?? 0 }));
    const decision = router.route(request, enriched, 'adaptive');
    waitMs += performance.now() - beforeRoute;
    if (previousAgent === decision.agentId) stable += 1;
    previousAgent = decision.agentId;
    const selected = profiles.find((agent) => agent.id === decision.agentId)!;
    const capabilityMatch = request.requiredCapabilities.every((capability) => selected.capabilities.includes(capability));
    if (capabilityMatch) routed += 1;
    const beforeExecution = performance.now();
    const success = capabilityMatch && ((index + profiles.findIndex((agent) => agent.id === decision.agentId)) % 11 !== 0);
    if (success) completed += 1;
    executionMs += performance.now() - beforeExecution;
    if (learning && memory) await (success ? learning.recordSuccess({ executionId: 'benchmark', taskId: `task-${index}`, taskType: request.taskType, agentId: decision.agentId, capabilities: request.requiredCapabilities, success: true, quality: 0.8, executionTimeMs: executionMs, attempts: 1 }) : learning.recordFailure({ executionId: 'benchmark', taskId: `task-${index}`, taskType: request.taskType, agentId: decision.agentId, capabilities: request.requiredCapabilities, success: false, quality: 0, executionTimeMs: executionMs, attempts: 1, error: 'deterministic benchmark failure' }));
  }
  const lookupStart = performance.now();
  if (memory) await memory.searchEntries({ query: 'analysis testing security', context: { subject: 'benchmark' }, limit: 20 });
  const lookupLatency = performance.now() - lookupStart;
  return { routingSuccessRate: routed / TASK_COUNT, taskCompletionRate: completed / TASK_COUNT, averageWaitMs: waitMs / TASK_COUNT, averageExecutionMs: executionMs / TASK_COUNT, routingStability: stable / Math.max(1, TASK_COUNT - 1), memoryLookupLatencyMs: lookupLatency, memoryCount: memory ? await memory.count() : 0 };
}

function requestFor(index: number): RoutingRequest {
  const taskType = index % 3 === 0 ? 'analysis' : index % 3 === 1 ? 'testing' : 'security';
  return { taskType, requiredCapabilities: [taskType], complexity: (index % 10) / 10 };
}

function capabilitiesFor(index: number): string[] {
  const values = ['analysis'];
  if (index % 2 === 0) values.push('testing');
  if (index % 3 === 0) values.push('security');
  return values;
}

await main();
