import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { HelixRuntime } from '../packages/runtime/src/index.js';

function percentile(values: number[], fraction: number): number { const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0; }
function summary(values: number[]) { return { count: values.length, p50: Number(percentile(values, 0.5).toFixed(4)), p95: Number(percentile(values, 0.95).toFixed(4)), p99: Number(percentile(values, 0.99).toFixed(4)), min: Number(Math.min(...values).toFixed(4)), max: Number(Math.max(...values).toFixed(4)) }; }
async function measured(count: number, operation: () => void | Promise<void>): Promise<number[]> { const values: number[] = []; for (let index = 0; index < count; index += 1) { const started = performance.now(); await operation(); values.push(performance.now() - started); } return values; }

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-control-plane-m16-'));
  const runtime = new HelixRuntime({ dataDirectory: directory, learningAsync: false });
  try {
    await runtime.init();
    while (runtime.agents.list().length < 100) { const index = runtime.agents.list().length; runtime.agents.register({ name: `m16-agent-${index}`, role: 'worker', capabilities: ['analysis', index % 2 ? 'coding' : 'testing'] }); }
    const control = runtime.controlPlane;
    const snapshotLatencies = await measured(100, async () => { await control.snapshot(); });
    const eventLatencies = await measured(500, async () => { control.events.publish({ type: 'task.queued', metadata: { benchmark: true } }); });
    const metricLatencies = await measured(1_000, () => { control.metrics.counter('benchmark.events'); control.metrics.histogram('benchmark.latency_ms', 1); });
    let traceIndex = 0; const traceLatencies = await measured(250, () => { const trace = control.traces.start({ executionId: `m16-trace-${traceIndex++}` }); control.traces.addDecision(trace.executionId, { name: 'agent-routing', selected: 'deterministic', rationale: ['capability-safe benchmark selection'], metadata: {} }); control.traces.finish(trace.executionId, 'completed'); });
    const agentLatencies = await measured(500, () => { runtime.agents.list(); });
    const execution = await runtime.execute({ goal: 'M16 control-plane benchmark execution', budget: { maxTasks: 64 } });
    const taskLatencies = await measured(500, () => { runtime.listTasks(); });
    const providerLatencies = await measured(500, () => { control.routeModel({ capabilities: ['analysis'], privateOnly: true }); });
    const currentSnapshot = await control.snapshot();
    const serializationLatencies = await measured(250, () => { JSON.stringify(currentSnapshot); });
    const agents100Started = performance.now(); const agentViews = Array.from({ length: 100 }, (_, index) => ({ id: `agent-${index}`, status: index % 7 === 0 ? 'busy' : 'idle', utilization: index % 7 === 0 ? 1 : 0 })); const agents100Ms = performance.now() - agents100Started;
    const tasks1000Started = performance.now(); const taskViews = Array.from({ length: 1_000 }, (_, index) => ({ id: `task-${index}`, status: index % 5 === 0 ? 'completed' : 'pending', retries: index % 3 })); JSON.stringify(taskViews); const tasks1000Ms = performance.now() - tasks1000Started;
    console.log(JSON.stringify({ benchmark: 'control-plane-m16', deterministic: true, registeredAgents: runtime.agents.list().length, executionId: execution.id, latencyMs: { snapshot: summary(snapshotLatencies), eventDispatch: summary(eventLatencies), metricRecording: summary(metricLatencies), traceCreation: summary(traceLatencies), agentListing: summary(agentLatencies), taskListing: summary(taskLatencies), providerRouting: summary(providerLatencies), dashboardApiSerialization: summary(serializationLatencies) }, simulations: { agents100: { records: agentViews.length, elapsedMs: Number(agents100Ms.toFixed(4)) }, tasks1000: { records: taskViews.length, elapsedMs: Number(tasks1000Ms.toFixed(4)) } }, notes: ['measurements are local deterministic observations', '100-agent and 1,000-task cases are bounded status/serialization simulations', 'no external provider call was made'] }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}
void main();
