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
