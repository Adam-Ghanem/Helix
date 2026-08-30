import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AutonomousAgentSystem } from '../packages/autonomy/src/index.js';
import { DurableSwarmState, SwarmCoordinator } from '../packages/swarm/src/index.js';

test('default agent catalog exposes at least 50 specialized roles', () => {
  const registry = new AgentRegistry();
  const names = registry.list().map((agent) => agent.name);
  assert.ok(names.length >= 50);
  for (const required of ['supervisor', 'judge', 'critic', 'code-reviewer', 'threat-hunter', 'performance-engineer']) {
    assert.ok(names.includes(required), `missing specialized role ${required}`);
  }
});

test('autonomous agent system spawns specialists, delegates within depth limits, and restores durable state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-autonomy-'));
  try {
    const registry = new AgentRegistry();
    const system = new AutonomousAgentSystem({ registry, stateFile: join(directory, 'autonomy.json'), maxDynamicAgents: 4, maxDelegationDepth: 2 });
    await system.init();
    const supervisor = await system.spawn('supervisor');
    const coder = await system.delegate({ parentAgentId: supervisor.agentId, objective: 'Implement the API safely', requiredCapabilities: ['coding', 'backend'] });
    assert.equal(coder.parentAgentId, supervisor.agentId);
    assert.equal(coder.depth, 1);
    assert.ok(registry.get(coder.agentId).capabilities.includes('backend'));

    const reviewer = await system.delegate({ parentAgentId: coder.agentId, objective: 'Review implementation quality', requiredCapabilities: ['review', 'quality'] });
    assert.equal(reviewer.depth, 2);
    await assert.rejects(() => system.delegate({ parentAgentId: reviewer.agentId, objective: 'Delegate too deeply', requiredCapabilities: ['analysis'] }), /delegation depth/i);

    const restoredRegistry = new AgentRegistry();
    const restored = new AutonomousAgentSystem({ registry: restoredRegistry, stateFile: join(directory, 'autonomy.json'), maxDynamicAgents: 4, maxDelegationDepth: 2 });
    await restored.init();
    assert.equal(restored.list().length, 3);
    assert.equal(restoredRegistry.get(coder.agentId).id, coder.agentId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('autonomous agent system enforces dynamic-agent capacity and supports termination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-autonomy-capacity-'));
  try {
    const registry = new AgentRegistry();
    const system = new AutonomousAgentSystem({ registry, stateFile: join(directory, 'autonomy.json'), maxDynamicAgents: 2 });
    await system.init();
    const first = await system.spawn('coder');
    await system.spawn('reviewer');
    await assert.rejects(() => system.spawn('tester'), /capacity/i);
    await system.terminate(first.agentId);
    const replacement = await system.spawn('tester');
    assert.equal(replacement.status, 'active');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('supervisor-worker swarm uses explicit supervisor and judge roles and persists execution state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-swarm-state-'));
  try {
    const registry = new AgentRegistry();
    const state = new DurableSwarmState(join(directory, 'swarms.json'));
    const coordinator = new SwarmCoordinator({ state });
    const agents = ['supervisor', 'coder', 'reviewer', 'judge'].map((name) => registry.findByName(name)!);
    const decision = await coordinator.run(
      [
        { id: 'implement', input: 'approve', requiredCapabilities: ['coding'] },
        { id: 'review', input: 'approve', requiredCapabilities: ['review'] },
      ],
      agents,
      async (assignment) => ({ value: assignment.task.input, evidence: [assignment.role] }),
      'supervisor-worker',
      { strategy: 'majority' },
    );
    assert.ok(decision.swarmId);
    assert.ok(decision.plan.assignments.some((assignment) => assignment.role === 'supervisor'));
    assert.ok(decision.plan.assignments.some((assignment) => assignment.role === 'judge'));
    const restored = new DurableSwarmState(join(directory, 'swarms.json'));
    const execution = await restored.get(decision.swarmId!);
    assert.equal(execution?.status, 'completed');
    assert.ok((execution?.rounds.length ?? 0) >= 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
