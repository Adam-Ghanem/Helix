import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../packages/durable/src/index.js';
import { TaskGraph } from '../packages/planner/src/index.js';
import { PolicyEngine, secureDefaultRules } from '../packages/policy/src/index.js';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentRouter } from '../packages/router/src/index.js';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { MemoryStore } from '../packages/memory/src/index.js';
import { ToolRegistry } from '../packages/tools/src/index.js';
import { McpGateway } from '../packages/mcp/src/index.js';
import { decide } from '../packages/consensus/src/index.js';
import { WorkflowEngine } from '../packages/workflows/src/index.js';
import { Telemetry } from '../packages/observability/src/index.js';
import { SwarmCoordinator } from '../packages/swarm/src/index.js';
import { KnowledgeGraph } from '../packages/knowledge/src/index.js';
import { EvaluationEngine } from '../packages/evaluation/src/index.js';
import { LearningEngine } from '../packages/learning/src/index.js';
import type { TaskRecord } from '../packages/core/src/index.js';

test('event store orders, persists, replays, and deduplicates events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-events-'));
  try {
    const store = new EventStore({ directory });
    const first = await store.append({ type: 'demo.created', payload: { value: 1 }, idempotencyKey: 'demo:1' });
    const duplicate = await store.append({ type: 'demo.created', payload: { value: 999 }, idempotencyKey: 'demo:1' });
    assert.equal(first.eventId, duplicate.eventId);
    assert.equal((await store.read()).length, 1);
    const replayed = await store.replay(0, (state, event) => state + Number((event.payload as { value: number }).value));
    assert.equal(replayed, 1);
    const restored = new EventStore({ directory });
    await restored.init();
    assert.equal(restored.lastSequence, 1);
    const persistedDuplicate = await restored.append({ type: 'demo.created', payload: { value: 2 }, idempotencyKey: 'demo:1' });
    assert.equal(persistedDuplicate.eventId, first.eventId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('task graph rejects cycles and protects dependency mutation', () => {
  const a: TaskRecord = { id: 'a', executionId: 'ex', title: 'a', description: 'a', dependencies: ['b'], status: 'pending', attempts: 0 };
  const b: TaskRecord = { id: 'b', executionId: 'ex', title: 'b', description: 'b', dependencies: ['a'], status: 'pending', attempts: 0 };
  assert.throws(() => new TaskGraph([a, b]), /cycle/i);
  const graph = new TaskGraph();
  const first = graph.addTask({ title: 'first', description: 'first' }, 'ex');
  const second = graph.addTask({ title: 'second', description: 'second', dependencies: [first.id] }, 'ex');
  assert.deepEqual(graph.ready().map((task) => task.id), [first.id]);
  graph.setStatus(first.id, 'running');
  graph.setStatus(first.id, 'completed');
  assert.deepEqual(graph.ready().map((task) => task.id), [second.id]);
});

test('policy engine defaults to deny and creates approval records', () => {
  const policy = new PolicyEngine(secureDefaultRules);
  const denied = policy.decide({ id: 'tool-1', executionId: 'ex', agentId: 'agent', tool: 'unknown.tool', input: {}, risk: 'low' }, { subject: 'agent' });
  assert.equal(denied.action, 'deny');
  const approval = policy.decide({ id: 'tool-2', executionId: 'ex', agentId: 'agent', tool: 'filesystem.write', input: {}, risk: 'medium' }, { subject: 'agent' });
  assert.equal(approval.action, 'approval');
  assert.ok(approval.approvalId);
  assert.equal(policy.approve(approval.approvalId!, 'human').status, 'approved');
});

test('router supports adaptive selection and agent reputation decay input', () => {
  const agents = new AgentRegistry(false);
  const strong = agents.register({ name: 'security-a', role: 'Security', capabilities: ['analysis', 'security'] });
  const weak = agents.register({ name: 'general-b', role: 'General', capabilities: ['analysis'] });
  agents.recordOutcome(strong.id, { taskType: 'security-review', domain: 'security', success: true, quality: 0.95, latencyMs: 20, tokens: 10 });
  agents.recordOutcome(weak.id, { taskType: 'security-review', domain: 'security', success: true, quality: 0.4, latencyMs: 20, tokens: 10 });
  const router = new AgentRouter();
  const result = router.route({ taskType: 'security-review', requiredCapabilities: ['security'], complexity: 0.8 }, [
    { agent: agents.get(strong.id), estimatedCostUsd: 0.1, availability: 1, memoryRelevance: 0.5 },
    { agent: agents.get(weak.id), estimatedCostUsd: 0.1, availability: 1, memoryRelevance: 0.5 },
  ]);
  assert.equal(result.agentId, strong.id);
});

test('runtime executes a durable task graph and records events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-runtime-'));
  try {
    const runtime = new HelixRuntime({ dataDirectory: directory });
    const execution = await runtime.execute({ goal: 'Analyze repository architecture' });
    assert.equal(execution.status, 'completed');
    assert.equal(execution.usage.tasks, 4);
    const view = await runtime.view(execution.id);
    assert.equal(view.tasks.filter((task) => task.status === 'completed').length, 4);
    assert.ok(view.events.some((event) => event.type === 'execution.completed'));
    assert.ok(view.events.some((event) => event.type === 'agent.decision'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('runtime retry resumes failed work and repeated views do not duplicate tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-retry-'));
  let calls = 0;
  try {
    const runtime = new HelixRuntime({
      dataDirectory: directory,
      provider: {
        name: 'flaky-test-provider',
        async execute(input) {
          calls += 1;
          if (calls === 1) throw new Error(`transient failure in ${input.task.title}`);
          return { output: { ok: true }, tokens: 1, costUsd: 0.001, quality: 0.9 };
        },
      },
    });
    const failed = await runtime.execute({ goal: 'Exercise retry recovery' });
    assert.equal(failed.status, 'failed');
    const before = await runtime.view(failed.id);
    const repeated = await runtime.view(failed.id);
    assert.equal(before.tasks.length, repeated.tasks.length);
    const checkpoint = await runtime.checkpoint(failed.id);
    assert.ok(checkpoint.sequence > 0);
    const recovered = await runtime.retry(failed.id);
    assert.equal(recovered.status, 'completed');
    assert.ok((await runtime.view(failed.id)).events.some((event) => event.type === 'execution.retry_requested'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime rehydrates completed executions from the event log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-rehydrate-'));
  try {
    const first = new HelixRuntime({ dataDirectory: directory });
    const execution = await first.execute({ goal: 'Persist this execution' });
    const second = new HelixRuntime({ dataDirectory: directory });
    const view = await second.view(execution.id);
    assert.equal(view.execution.status, 'completed');
    assert.equal(view.tasks.length, 4);
    assert.equal(view.events.filter((event) => event.type === 'task.created').length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('memory persists provenance and enforces namespace subject access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-memory-'));
  try {
    const memory = new MemoryStore(directory);
    const record = await memory.store({ namespace: 'project-a', owner: 'agent-a', content: 'The scheduler uses durable leases', importance: 0.9, confidence: 0.95, source: { executionId: 'ex-1', agentId: 'agent-a' }, allowedSubjects: ['agent-a'] });
    assert.equal((await memory.search({ query: 'durable leases', namespace: 'project-a', subject: 'agent-a' })).length, 1);
    assert.equal((await memory.search({ query: 'durable leases', namespace: 'project-a', subject: 'agent-b' })).length, 0);
    const restored = new MemoryStore(directory);
    assert.equal((await restored.search({ query: 'scheduler', namespace: 'project-a', subject: 'agent-a' }))[0]?.record.id, record.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tool registry and MCP gateway require schema-valid governed requests', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'filesystem.read', description: 'Read an approved file', risk: 'low', permissions: ['filesystem:read'], inputSchema: { required: ['path'], properties: { path: 'string' } }, source: 'builtin', handler: async (input) => ({ path: input.path }) });
  const request = registry.request('filesystem.read', 'ex', 'agent', { path: '/tmp/a' });
  assert.equal((await registry.executeAuthorized(request, async () => true) as { path: string }).path, '/tmp/a');
  assert.throws(() => registry.request('filesystem.read', 'ex', 'agent', { path: 12 }), /Invalid input/);
  const gateway = new McpGateway(registry);
  gateway.registerServer({ id: 'review', endpoint: 'https://mcp.example.test', transport: 'streamable-http', trust: 'reviewed' });
  const imported = gateway.importManifest('review', [{ name: 'scan', description: 'Scan content', inputSchema: { required: ['text'], properties: { text: 'string' } } }]);
  assert.equal(imported[0]?.source, 'mcp');
  gateway.assertExecutionBoundary(imported[0]!.name);
});

test('consensus and workflows provide deterministic multi-agent coordination primitives', async () => {
  const consensus = decide([{ voterId: 'a', value: 'safe', confidence: 0.9 }, { voterId: 'b', value: 'safe', confidence: 0.8 }, { voterId: 'c', value: 'unsafe', confidence: 0.9 }], { strategy: 'confidence-weighted', threshold: 0.55 });
  assert.equal(consensus.reached, true);
  assert.equal(consensus.value, 'safe');
  const engine = new WorkflowEngine();
  const result = await engine.run({ name: 'review', version: 1, nodes: [
    { id: 'a', kind: 'agent', title: 'Architect', description: 'architecture' },
    { id: 'b', kind: 'agent', title: 'Reviewer', description: 'review', dependsOn: ['a'] },
  ] }, 'ex-workflow', async (node) => ({ node: node.id, ok: true }));
  assert.equal(result.status, 'completed');
  assert.equal(result.nodes.filter((node) => node.status === 'completed').length, 2);
});

test('telemetry records correlated spans, metrics, and structured logs', () => {
  const telemetry = new Telemetry();
  const root = telemetry.startSpan('execution', { 'execution.id': 'ex' });
  const child = telemetry.startSpan('task', { 'task.id': 'task' }, root);
  telemetry.endSpan(child);
  telemetry.endSpan(root);
  telemetry.recordMetric('task.completed', 1, { provider: 'test' });
  telemetry.log('info', 'task completed', { executionId: 'ex' });
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.spans.length, 2);
  assert.equal(snapshot.spans[1]?.parentId, root.id);
  assert.equal(snapshot.metrics[0]?.name, 'task.completed');
  assert.equal(snapshot.logs[0]?.attributes.executionId, 'ex');
});


test('swarm coordinator selects adaptive topology and reaches consensus', async () => {
  const agents = new AgentRegistry(false);
  const first = agents.register({ name: 'one', role: 'worker', capabilities: ['analysis'] });
  const second = agents.register({ name: 'two', role: 'worker', capabilities: ['analysis'] });
  const coordinator = new SwarmCoordinator();
  const result = await coordinator.run([{ id: 't1', input: 'review', requiredCapabilities: ['analysis'] }, { id: 't2', input: 'review', requiredCapabilities: ['analysis'] }], [first, second], async (assignment) => ({ value: 'approve', evidence: [assignment.agent.name] }), 'adaptive', { strategy: 'majority' });
  assert.equal(result.plan.topology, 'pipeline');
  assert.equal(result.consensus?.reached, true);
});

test('knowledge graph preserves provenance and traverses relations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-knowledge-'));
  try {
    const graph = new KnowledgeGraph(directory);
    const execution = await graph.upsertEntity({ type: 'execution', name: 'ex-1', properties: { goal: 'review' }, confidence: 0.9, provenance: { executionId: 'ex-1' } });
    const agent = await graph.upsertEntity({ type: 'agent', name: 'security', properties: {}, confidence: 0.8, provenance: { agentId: 'agent-1' } });
    await graph.relate({ from: execution.id, to: agent.id, type: 'performed-by', confidence: 0.95, provenance: { executionId: 'ex-1', agentId: 'agent-1' } });
    const neighborhood = await graph.neighborhood(execution.id);
    assert.equal(neighborhood.entities[0]?.name, 'security');
    const restored = new KnowledgeGraph(directory);
    assert.equal((await restored.listEntities('execution')).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('evaluation and learning engines produce structured, reusable evidence', async () => {
  const evaluation = new EvaluationEngine();
  evaluation.registerRule('non-empty', (output) => typeof output === 'string' && output.length > 0, 'output must be non-empty');
  evaluation.registerSchema('report', ['summary']);
  evaluation.registerTest('quality', async (output) => Boolean(output));
  const results = await evaluation.evaluate({ output: { summary: 'ok' } });
  assert.equal(results.length, 3);
  assert.equal(results.every((result) => result.authoritative), true);
  const learning = new LearningEngine();
  const patterns = learning.record({ executionId: 'ex', steps: [{ taskType: 'review', agentId: 'agent', strategy: 'adaptive', latencyMs: 10, costUsd: 0, success: true }], evaluation: { success: true, quality: 0.9, costUsd: 0, latencyMs: 10, reliability: 1, toolEfficiency: 1, notes: [] } });
  assert.equal(patterns[0]?.kind, 'successful-strategy');
  assert.equal(learning.recommend('review')[0]?.key.includes('review'), true);
});
