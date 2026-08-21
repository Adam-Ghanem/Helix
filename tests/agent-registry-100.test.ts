import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TYPES, AgentRegistry } from '../packages/agents/src/index.js';

test('100-agent swarm registry', async (t) => {
  await t.test('provides at least 25 specialized agent types', () => {
    assert.ok(AGENT_TYPES.length >= 25);
    assert.equal(new Set(AGENT_TYPES.map((agent) => agent.type)).size, AGENT_TYPES.length);
  });

  await t.test('seeds exactly 100 agents with specialized capabilities', () => {
    const registry = new AgentRegistry(true, 100);
    const agents = registry.list();
    assert.equal(agents.length, 100);
    assert.equal(new Set(agents.map((agent) => agent.name)).size, 100);
    assert.ok(agents.every((agent) => agent.status === 'idle'));
    assert.ok(agents.every((agent) => agent.capabilities.length > 0));
  });

  await t.test('supports an empty registry for externally managed agent pools', () => {
    const registry = new AgentRegistry(false);
    assert.equal(registry.list().length, 0);
    assert.equal(registry.seed(5).length, 5);
  });
});
