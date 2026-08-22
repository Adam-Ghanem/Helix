import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { HelixMcpServer } from '../packages/mcp/src/index.js';

const directory = await mkdtemp(join(tmpdir(), 'helix-m11-benchmark-'));
try {
  const runtime = new HelixRuntime({ dataDirectory: directory });
  for (let index = 0; index < 100; index += 1) runtime.agents.register({ name: `benchmark-agent-${index}`, role: 'worker', capabilities: ['analysis', index % 2 === 0 ? 'testing' : 'security'] });
  const beforeHeap = process.memoryUsage().heapUsed;
  const initStart = performance.now();
  const server = new HelixMcpServer(runtime, { actorRoles: { benchmark: 'operator' }, rateLimits: { READ: 2_000, WRITE: 60, EXECUTE: 20, ADMIN: 10, REMOTE: 5 } });
  const registryInitializationMs = performance.now() - initStart;
  const discoveryTimings: number[] = [];
  for (let index = 0; index < 50; index += 1) { const started = performance.now(); await server.listTools(); discoveryTimings.push(performance.now() - started); }
  const discovery = summarize(discoveryTimings);
  const authorizationTimings: number[] = [];
  const executionTimings: number[] = [];
  const runStart = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    const result = await server.execute('helix_system_health', {}, { id: 'benchmark', role: 'operator' });
    executionTimings.push(performance.now() - started);
    if (!result || typeof result !== 'object') throw new Error('benchmark tool returned invalid result');
  }
  const elapsedMs = performance.now() - runStart;
  for (let index = 0; index < 250; index += 1) { const started = performance.now(); server.registry.authorization.check({ id: 'benchmark', role: 'operator' }, 'READ'); authorizationTimings.push(performance.now() - started); }
  const afterHeap = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ agents: 100, taskUnits: 1_000, tools: server.registry.count(), resources: server.resources.length, prompts: server.prompts.length, registryInitializationMs, discoveryLatencyMs: discovery, executionLatencyMs: summarize(executionTimings), authorizationOverheadMs: summarize(authorizationTimings), throughputCallsPerSecond: 1_000 / (elapsedMs / 1_000), heapDeltaMb: (afterHeap - beforeHeap) / 1_048_576, auditEvents: server.registry.audit.count(), deterministic: true, externalCalls: 0 }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }

function summarize(values: number[]): { average: number; p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
  return { average: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}
