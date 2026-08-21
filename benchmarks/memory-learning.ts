import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentRouter, type RoutingCandidate, type RoutingRequest } from '../packages/router/src/index.js';
import { MemoryStore, SqliteMemoryStore, type MemoryBackend, type MemoryEntryInput } from '../packages/memory/src/index.js';
import { PersistentLearningEngine } from '../packages/learning/src/index.js';

interface BenchmarkMetrics {
  backend: 'm9-jsonl' | 'm10-sqlite';
  agents: number;
  tasks: number;
  seededMemories: number;
  memoryCount: number;
  routingSuccessRate: number;
  taskCompletionRate: number;
  throughputTasksPerSecond: number;
  routingLatencyMs: { average: number; p50: number; p95: number; p99: number };
  memoryLookupLatencyMs: { average: number; p50: number; p95: number; p99: number };
  memoryWriteLatencyMs: { average: number; p50: number; p95: number; p99: number };
  averageExecutionMs: number;
  routingStability: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  heapDeltaMb: number;
}

const AGENT_COUNT = 100;
const TASK_COUNT = 1_000;
const SEEDED_MEMORY_COUNT = 10_000;
const BATCH_SIZE = 250;

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-m10-benchmark-'));
  try {
    const agents = new AgentRegistry(false);
    for (let index = 0; index < AGENT_COUNT; index += 1) agents.register({ name: `agent-${index}`, role: 'benchmark-worker', capabilities: capabilitiesFor(index) });
    const profiles = agents.list();
    const m9 = await runScenario('m9-jsonl', new MemoryStore(join(directory, 'm9')) , profiles);
    const m10Store = new SqliteMemoryStore(join(directory, 'm10', 'memory.sqlite'), { retrievalLimit: 512, cache: { maxEntries: 512, ttlMs: 60_000 } });
    const m10 = await runScenario('m10-sqlite', m10Store, profiles);
    m10Store.close();
    const deltas = {
      memoryLookupAverageMs: m10.memoryLookupLatencyMs.average - m9.memoryLookupLatencyMs.average,
      memoryLookupP95Ms: m10.memoryLookupLatencyMs.p95 - m9.memoryLookupLatencyMs.p95,
      routingAverageMs: m10.routingLatencyMs.average - m9.routingLatencyMs.average,
      memoryWriteAverageMs: m10.memoryWriteLatencyMs.average - m9.memoryWriteLatencyMs.average,
      taskCompletionRate: m10.taskCompletionRate - m9.taskCompletionRate,
      throughputTasksPerSecond: m10.throughputTasksPerSecond - m9.throughputTasksPerSecond,
    };
    console.log(JSON.stringify({ agents: AGENT_COUNT, tasks: TASK_COUNT, seededMemories: SEEDED_MEMORY_COUNT, m9, m10, deltas }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runScenario(backend: BenchmarkMetrics['backend'], memory: MemoryBackend, profiles: ReturnType<AgentRegistry['list']>): Promise<BenchmarkMetrics> {
  await memory.init();
  await seedMemory(memory, backend);
  const learning = new PersistentLearningEngine(memory);
  const router = new AgentRouter();
  let routed = 0;
  let completed = 0;
  let stable = 0;
  let previousAgent: string | undefined;
  let executionMs = 0;
  const routingTimings: number[] = [];
  const lookupTimings: number[] = [];
  const writeTimings: number[] = [];
  const cpuStart = process.cpuUsage();
  const heapStart = process.memoryUsage().heapUsed;
  const runStart = performance.now();

  for (let index = 0; index < TASK_COUNT; index += 1) {
    const request = requestFor(index);
    const candidates: RoutingCandidate[] = profiles.map((agent) => ({ agent, estimatedCostUsd: 0, availability: 1, memoryRelevance: 0.5 }));
    const routeStart = performance.now();
    const scores = await learning.routingScores(request, candidates);
    const enriched = candidates.map((candidate) => ({ ...candidate, learningBonus: scores.get(candidate.agent.id) ?? 0 }));
    const decision = router.route(request, enriched, 'adaptive');
    routingTimings.push(performance.now() - routeStart);
    if (previousAgent === decision.agentId) stable += 1;
    previousAgent = decision.agentId;
    const selected = profiles.find((agent) => agent.id === decision.agentId);
    const capabilityMatch = selected ? request.requiredCapabilities.every((capability) => selected.capabilities.includes(capability)) : false;
    if (capabilityMatch) routed += 1;
    const executionStart = performance.now();
    const success = capabilityMatch && ((index + profiles.findIndex((agent) => agent.id === decision.agentId)) % 11 !== 0);
    if (success) completed += 1;
    executionMs += performance.now() - executionStart;
    const writeStart = performance.now();
    const outcome = { executionId: backend, taskId: `task-${index}`, taskType: request.taskType, agentId: decision.agentId, capabilities: request.requiredCapabilities, success, quality: success ? 0.8 : 0, executionTimeMs: executionMs, attempts: 1, ...(success ? {} : { error: 'deterministic benchmark failure' }) };
    if (success) await learning.recordSuccess(outcome); else await learning.recordFailure(outcome);
    writeTimings.push(performance.now() - writeStart);
  }

  for (let index = 0; index < 50; index += 1) {
    const lookupStart = performance.now();
    await memory.searchEntries({ query: 'analysis testing security m10 solution', retrievalLimit: 512, limit: 20, context: { subject: 'benchmark' } });
    lookupTimings.push(performance.now() - lookupStart);
  }
  const cpu = process.cpuUsage(cpuStart);
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapStart) / 1_048_576;
  const elapsedMs = performance.now() - runStart;
  return {
    backend, agents: AGENT_COUNT, tasks: TASK_COUNT, seededMemories: SEEDED_MEMORY_COUNT, memoryCount: await memory.count(),
    routingSuccessRate: routed / TASK_COUNT, taskCompletionRate: completed / TASK_COUNT, throughputTasksPerSecond: TASK_COUNT / (elapsedMs / 1_000),
    routingLatencyMs: summarize(routingTimings), memoryLookupLatencyMs: summarize(lookupTimings), memoryWriteLatencyMs: summarize(writeTimings),
    averageExecutionMs: executionMs / TASK_COUNT, routingStability: stable / Math.max(1, TASK_COUNT - 1), cpuUserMs: cpu.user / 1_000, cpuSystemMs: cpu.system / 1_000, heapDeltaMb,
  };
}

async function seedMemory(memory: MemoryBackend, backend: BenchmarkMetrics['backend']): Promise<void> {
  for (let start = 0; start < SEEDED_MEMORY_COUNT; start += BATCH_SIZE) {
    const inputs = Array.from({ length: Math.min(BATCH_SIZE, SEEDED_MEMORY_COUNT - start) }, (_, offset) => {
      const index = start + offset;
      const taskType = index % 3 === 0 ? 'analysis' : index % 3 === 1 ? 'testing' : 'security';
      const input: MemoryEntryInput = { namespace: 'global', type: index % 4 === 0 ? 'solution' : 'pattern', content: `${taskType} m10 benchmark solution pattern ${index}`, metadata: { taskType, index, backend }, source: 'benchmark', confidence: 0.6 + (index % 4) * 0.1, tags: ['benchmark', taskType, 'm10'], provenance: { sourceType: 'system', sourceId: `${backend}-${index}`, timestamp: new Date().toISOString(), confidence: 0.8 }, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } };
      return { input };
    });
    if (memory.createMany) await memory.createMany(inputs); else for (const input of inputs) await memory.create(input.input);
  }
}

function summarize(values: number[]): { average: number; p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
  return { average: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
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
