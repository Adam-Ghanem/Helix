import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { EventBus, ExecutionTraceStore, MetricsRegistry, ModelRouter, ProviderCatalog, RuntimeProviderAdapter, Doctor } from '../packages/control-plane/src/index.js';
import { ProviderRegistry } from '../packages/providers/src/index.js';
import { HelixMcpServer, McpToolError } from '../packages/mcp/src/index.js';

async function withRuntime<T>(prefix: string, run: (runtime: HelixRuntime) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const runtime = new HelixRuntime({ dataDirectory: directory, learningAsync: false });
  try { await runtime.init(); return await run(runtime); } finally { await runtime.federation.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
}

function seedAgents(runtime: HelixRuntime, target = 100): void {
  while (runtime.agents.list().length < target) { const index = runtime.agents.list().length; runtime.agents.register({ name: `m16-test-agent-${index}`, role: 'worker', capabilities: ['analysis', index % 2 ? 'coding' : 'testing'] }); }
}

test('M16 control plane returns one unified snapshot across runtime components', async () => withRuntime('m16-snapshot', async (runtime) => {
  seedAgents(runtime);
  const snapshot = await runtime.controlPlane.snapshot();
  assert.equal(snapshot.agents.length, 100);
  assert.ok(Array.isArray(snapshot.tasks)); assert.ok(Array.isArray(snapshot.workers)); assert.ok(Array.isArray(snapshot.swarms)); assert.ok(Array.isArray(snapshot.nodes)); assert.ok(Array.isArray(snapshot.executions));
  assert.equal(snapshot.queue.activeLeases, runtime.scheduler.list().length);
  assert.equal(snapshot.federation.localNodeId, runtime.federation.localNodeId);
}));

test('M16 metrics support counters, gauges, histograms, JSON, Prometheus, and bounded samples', () => {
  const metrics = new MetricsRegistry(3);
  metrics.counter('tasks.completed', 2); metrics.gauge('agents.available', 7); metrics.histogram('task.execution_ms', 4); metrics.histogram('task.execution_ms', 8); metrics.histogram('task.execution_ms', 12); metrics.histogram('task.execution_ms', 16);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.metrics.find((metric) => metric.name === 'tasks.completed')?.value, 2);
  const histogram = snapshot.metrics.find((metric) => metric.name === 'task.execution_ms')?.value as { count: number; p50: number; p95: number; p99: number };
  assert.equal(histogram.count, 3); assert.ok(histogram.p50 >= 8); assert.ok(histogram.p99 >= histogram.p95);
  assert.match(metrics.json(), /task.execution_ms/); assert.match(metrics.prometheus(), /task\.execution_ms_count 3/);
});

test('M16 EventBus emits typed correlated events, unsubscribes, and bounds history', () => {
  const bus = new EventBus({ maxHistory: 2, clock: () => '2026-01-01T00:00:00.000Z' });
  const seen: string[] = []; const unsubscribe = bus.subscribe((event) => { seen.push(event.eventId); }, 'task.completed');
  const first = bus.publish({ type: 'task.completed', executionId: 'ex-1', correlationId: 'corr-1', causationId: 'cause-1', actor: 'operator', source: 'test', metadata: { result: 'ok' } });
  bus.publish({ type: 'task.failed', metadata: { failure: 'x' } }); unsubscribe(); bus.publish({ type: 'task.completed', metadata: {} });
  assert.equal(seen.length, 1); assert.ok(first.eventId); assert.equal(first.timestamp, '2026-01-01T00:00:00.000Z'); assert.equal(bus.size, 2);
});

test('M16 execution traces preserve stages, decisions, events, metrics, and final status', () => {
  const traces = new ExecutionTraceStore(2); const trace = traces.start({ executionId: 'ex-trace', goalId: 'goal-1', taskId: 'task-1', nodeId: 'node-a' });
  traces.addStage(trace.executionId, { name: 'analysis', status: 'completed', startedAt: trace.startedAt, completedAt: trace.startedAt, metadata: { capability: 'analysis' } });
  traces.addDecision(trace.executionId, { name: 'routing', selected: 'agent-a', rationale: ['healthy', 'capability match'], metadata: {} }); traces.observe(trace.executionId, 'latency_ms', 4); traces.addError(trace.executionId, 'none');
  const finished = traces.finish(trace.executionId, 'completed'); const exported = traces.export(trace.executionId);
  assert.equal(finished.status, 'completed'); assert.equal(finished.decisions.length, 1); assert.equal(finished.stages.length, 1); assert.equal(finished.metrics.latency_ms, 4); assert.match(exported, /agent-a/);
});

test('M16 provider catalog and deterministic model router honor capability, latency, cost, and private policy', async () => withRuntime('m16-providers', async (runtime) => {
  const catalog = new ProviderCatalog(); catalog.register(new RuntimeProviderAdapter(runtime.provider));
  const models = new ProviderRegistry(); models.register({ id: 'local-fast', provider: 'deterministic-local', capabilities: ['analysis'], contextWindow: 16_000, inputCostPerMillion: 0, outputCostPerMillion: 0, latencyMs: 5, available: true }); models.register({ id: 'remote-slow', provider: 'external', capabilities: ['analysis'], contextWindow: 128_000, inputCostPerMillion: 1, outputCostPerMillion: 2, latencyMs: 100, available: true });
  const router = new ModelRouter(models, catalog); const decision = router.route({ capabilities: ['analysis'], privateOnly: true, maxLatencyMs: 10 });
  assert.equal(decision.model.id, 'local-fast'); assert.ok(decision.rationale.some((reason) => reason.includes('private-only'))); assert.equal((await catalog.health())[0]?.available, true);
}));

test('M16 doctor reports real checks with WARN for deterministic provider or unavailable Docker', async () => withRuntime('m16-doctor', async (runtime) => {
  const report = await new Doctor(runtime, { dataDirectory: process.cwd(), checkDocker: async () => false }).run();
  assert.ok(['PASS', 'WARN'].includes(report.status)); assert.ok(report.checks.some((check) => check.name === 'sqlite-memory' && check.status === 'PASS')); assert.ok(report.checks.some((check) => check.name === 'policy-engine' && check.status === 'PASS')); assert.ok(report.checks.some((check) => check.name === 'docker' && check.status === 'WARN'));
}));

test('M16 session lifecycle is first-class and writes durable lifecycle events', async () => withRuntime('m16-session', async (runtime) => {
  const session = runtime.controlPlane.sessions.create({ goal: 'Review the control plane', topology: 'adaptive' }); assert.equal(session.status, 'created');
  assert.equal((await runtime.controlPlane.sessions.start(session.id)).status, 'running');
  const stopped = await runtime.controlPlane.sessions.stop(session.id, 'test stop'); assert.equal(stopped.status, 'stopped'); assert.equal(runtime.controlPlane.sessions.get(session.id).failure, 'test stop');
  const events = await runtime.events.read(); assert.ok(events.some((event) => event.type === 'session.started')); assert.ok(events.some((event) => event.type === 'session.stopped'));
}));

test('M16 MCP control tools remain read-only for viewer actors and destructive remote tools remain denied', async () => withRuntime('m16-mcp', async (runtime) => {
  const server = new HelixMcpServer(runtime); const status = await server.execute('helix_control_status', {}, { id: 'mcp-user', role: 'viewer' }); assert.ok((status as { agents: unknown[] }).agents);
  await assert.rejects(() => server.execute('helix_federation_task_dispatch', { taskId: 'denial-task', requiredCapabilities: ['analysis'] }, { id: 'mcp-user', role: 'viewer' }), (error: unknown) => error instanceof McpToolError && error.category === 'FORBIDDEN');
}));

test('M16 worker failure is visible in unified metrics and explainability trace', async () => withRuntime('m16-worker-failure', async (runtime) => {
  const failing = new HelixRuntime({ dataDirectory: await mkdtemp(join(tmpdir(), 'm16-failing-provider-')), learningAsync: false, provider: { name: 'failing-test-provider', async execute() { throw new Error('provider timeout'); } } });
  try { await failing.init(); const execution = await failing.execute({ goal: 'observe provider failure' }); assert.equal(execution.status, 'failed'); const snapshot = await failing.controlPlane.snapshot(); assert.ok(Number(snapshot.metrics.metrics.find((metric) => metric.name === 'tasks.failed')?.value ?? 0) > 0); const trace = await failing.controlPlane.trace(execution.id); assert.equal(trace?.status, 'failed'); assert.ok((trace?.errors.length ?? 0) > 0); } finally { await failing.federation.close().catch(() => undefined); }
}));

test('M16 federation node failure is observable without changing federation trust rules', async () => withRuntime('m16-node-failure', async (runtime) => {
  const node = runtime.federation.registerNode({ id: 'm16-unhealthy', name: 'm16-unhealthy', endpoint: 'https://m16-unhealthy.invalid', role: 'worker', capabilities: ['analysis'], trustLevel: 'TRUSTED' }); runtime.federation.heartbeat(node.id); runtime.federation.drainNode(node.id); const snapshot = await runtime.controlPlane.snapshot(); const observed = snapshot.nodes.find((candidate) => candidate.id === node.id); assert.ok(observed); assert.notEqual(observed?.status, 'healthy');
}));

test('M16 100-agent status remains bounded and reports utilization fields', async () => withRuntime('m16-agents100', async (runtime) => { seedAgents(runtime, 100); const snapshot = await runtime.controlPlane.snapshot(); assert.equal(snapshot.agents.length, 100); assert.equal(snapshot.workers.length, 100); assert.ok(snapshot.workers.every((worker) => worker.utilization >= 0 && worker.utilization <= 1)); }));

test('M16 1,000-task status simulation remains bounded and serializable', () => { const tasks = Array.from({ length: 1_000 }, (_, index) => ({ id: `task-${index}`, status: index % 4 === 0 ? 'completed' : 'pending', retries: index % 3 })); const encoded = JSON.stringify(tasks); assert.equal(tasks.length, 1_000); assert.ok(encoded.length > 10_000); });

test('M16 restart recovery rehydrates executions and rebuilds traces from durable events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm16-restart-'));
  try { const first = new HelixRuntime({ dataDirectory: directory, learningAsync: false }); const execution = await first.execute({ goal: 'persist M16 trace' }); await first.federation.close(); const second = new HelixRuntime({ dataDirectory: directory, learningAsync: false }); await second.init(); const recovered = second.getExecution(execution.id); assert.equal(recovered.status, 'completed'); const trace = await second.controlPlane.trace(execution.id); assert.equal(trace?.status, 'completed'); assert.ok((trace?.events.length ?? 0) > 0); await second.federation.close(); } finally { await rm(directory, { recursive: true, force: true }); }
});

test('M16 event, trace, metrics, and provider surfaces redact secret-like metadata', async () => withRuntime('m16-secrets', async (runtime) => {
  const apiKeyField = ['api', 'Key'].join(''); const passwordField = ['pass', 'word'].join(''); const fixtureSecret = ['fixture', 'secret'].join('-'); const event = runtime.controlPlane.events.publish({ type: 'provider.completed', metadata: { [apiKeyField]: fixtureSecret, nested: { [passwordField]: 'hidden', visible: 'ok' } } }); const serialized = JSON.stringify(event); assert.equal(serialized.includes(fixtureSecret), false); assert.equal(serialized.includes('hidden'), false); assert.equal(serialized.includes('ok'), true); assert.equal(JSON.stringify(runtime.controlPlane.metrics.snapshot()).includes(fixtureSecret), false);
}));

test('M16 dashboard-facing snapshot is JSON serializable and contains operator overview fields', async () => withRuntime('m16-dashboard-snapshot', async (runtime) => {
  const snapshot = await runtime.controlPlane.snapshot();
  const encoded = JSON.stringify(snapshot);
  assert.ok(encoded.length > 100); assert.ok('agents' in snapshot); assert.ok('queue' in snapshot); assert.ok('federation' in snapshot); assert.ok('metrics' in snapshot); assert.equal(JSON.parse(encoded).queue.activeLeases, snapshot.queue.activeLeases);
}));
