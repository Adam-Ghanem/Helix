import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HelixRuntime } from '../dist/packages/runtime/src/index.js';

const iterations = Number(process.argv[2] ?? 10);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) throw new Error('iterations must be an integer from 1 to 1000');
const directory = await mkdtemp(join(tmpdir(), 'helix-benchmark-'));
try {
  const runtime = new HelixRuntime({ dataDirectory: directory });
  const latencies = [];
  let totalTasks = 0;
  let totalEvents = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const execution = await runtime.execute({ goal: `Measured benchmark execution ${index + 1}` });
    const view = await runtime.view(execution.id);
    latencies.push(performance.now() - started);
    totalTasks += view.tasks.length;
    totalEvents += view.events.length;
  }
  const totalMs = latencies.reduce((sum, value) => sum + value, 0);
  console.log(JSON.stringify({ iterations, totalMs: Math.round(totalMs * 100) / 100, averageMs: Math.round((totalMs / iterations) * 100) / 100, minMs: Math.round(Math.min(...latencies) * 100) / 100, maxMs: Math.round(Math.max(...latencies) * 100) / 100, executionsPerSecond: Math.round((iterations / (totalMs / 1000)) * 100) / 100, averageTasks: totalTasks / iterations, averageEvents: totalEvents / iterations, provider: runtime.provider.name }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
