import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentScheduler } from '../packages/scheduler/src/index.js';
import { SimulatedExecutor, WorkerPool } from '../packages/workers/src/index.js';

test('worker pool executes tasks and records outcomes', async () => {
  const registry = new AgentRegistry(true, 100);
  const scheduler = new AgentScheduler(registry, undefined, { defaultAgentCapacity: 1 });
  const pool = new WorkerPool(scheduler, registry, { executor: new SimulatedExecutor(1) });
  scheduler.enqueue({ title: 'code task', requiredCapabilities: ['coding'], estimatedComplexity: 1 });
  const events: string[] = [];
  pool.on((event) => events.push(event.type));
  await pool.runOnce();
  assert.equal(scheduler.metrics().completed, 1);
  assert.ok(events.includes('worker.started'));
  assert.ok(events.includes('worker.completed'));
  assert.ok(registry.list().some((agent) => agent.health.samples > 0));
});

test('capacity prevents over-assignment', () => {
  const registry = new AgentRegistry(true, 1);
  const scheduler = new AgentScheduler(registry, undefined, { defaultAgentCapacity: 1 });
  scheduler.enqueue({ title: 'a', requiredCapabilities: ['coding'] });
  scheduler.enqueue({ title: 'b', requiredCapabilities: ['coding'] });
  assert.equal(scheduler.tick().length, 1);
  assert.equal(scheduler.tick().length, 0);
});

test('100 agents can process many simulated tasks', async () => {
  const registry = new AgentRegistry(true, 100);
  const scheduler = new AgentScheduler(registry, undefined, { defaultAgentCapacity: 2 });
  const pool = new WorkerPool(scheduler, registry, { executor: new SimulatedExecutor(1) });
  for (let i = 0; i < 200; i++) scheduler.enqueue({ title: `task-${i}`, requiredCapabilities: [i % 2 ? 'coding' : 'analysis'], estimatedComplexity: 1 });
  await pool.drain();
  assert.equal(scheduler.metrics().completed, 200);
  assert.equal(pool.metrics().active, 0);
});
