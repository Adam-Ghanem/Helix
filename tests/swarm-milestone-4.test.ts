import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentScheduler } from '../packages/scheduler/src/index.js';
import { WorkerPool } from '../packages/workers/src/index.js';
import { createM4Swarm, chooseAdaptiveTopology, planMesh } from '../packages/swarm/src/m4-index.js';

test('hierarchical swarm completes a deterministic multi-step goal', async () => {
  const registry = new AgentRegistry(true, 100);
  const scheduler = new AgentScheduler(registry);
  const pool = new WorkerPool(scheduler, registry, { workerTimeoutMs: 2_000 });
  const swarm = createM4Swarm('m4-hier', { topology: 'hierarchical', maxAgents: 8 }, registry, scheduler, pool);
  const metrics = await swarm.run('build and test a TypeScript feature');
  assert.equal(metrics.agents, 8);
  assert.equal(metrics.status, 'completed');
  assert.equal(metrics.failed, 0);
});

test('mesh produces peer assignments', () => {
  const registry = new AgentRegistry(true, 20);
  const tasks = [
    { id: 'a', title: 'code', description: '', requiredCapabilities: ['coding'] },
    { id: 'b', title: 'test', description: '', requiredCapabilities: ['testing'] },
    { id: 'c', title: 'review', description: '', requiredCapabilities: ['review'] },
  ];
  const assignments = planMesh(tasks, registry.list(), 10);
  assert.equal(assignments.length, 3);
  assert.ok(assignments.every((assignment) => assignment.role === 'peer'));
});

test('adaptive policy switches under forced failure or queue pressure', () => {
  assert.equal(chooseAdaptiveTopology('hierarchical', { failureRate: 0.5, queueWaitMs: 0, parallel: true }, { failureRateThreshold: 0.25, queueWaitThresholdMs: 100 }), 'mesh');
  assert.equal(chooseAdaptiveTopology('hierarchical', { failureRate: 0, queueWaitMs: 500, parallel: true }, { failureRateThreshold: 0.25, queueWaitThresholdMs: 100 }), 'mesh');
});

test('swarm respects maxAgents', () => {
  const registry = new AgentRegistry(true, 100);
  const scheduler = new AgentScheduler(registry);
  const pool = new WorkerPool(scheduler, registry);
  const swarm = createM4Swarm('bounded', { topology: 'mesh', maxAgents: 5 }, registry, scheduler, pool);
  assert.equal(swarm.metrics().agents, 5);
});
