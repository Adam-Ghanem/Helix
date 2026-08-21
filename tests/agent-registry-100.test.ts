import { describe, expect, it } from 'vitest';
import { AGENT_TYPES, AgentRegistry } from '../packages/agents/src/index.js';

describe('100-agent swarm registry', () => {
  it('provides at least 25 specialized agent types', () => {
    expect(AGENT_TYPES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(AGENT_TYPES.map((agent) => agent[0])).size).toBe(AGENT_TYPES.length);
  });

  it('seeds exactly 100 agents with specialized capabilities', () => {
    const registry = new AgentRegistry(true, 100);
    const agents = registry.list();
    expect(agents).toHaveLength(100);
    expect(new Set(agents.map((agent) => agent.name)).size).toBe(100);
    expect(agents.every((agent) => agent.status === 'idle')).toBe(true);
    expect(agents.every((agent) => agent.capabilities.length > 0)).toBe(true);
  });

  it('supports an empty registry for externally managed agent pools', () => {
    const registry = new AgentRegistry(false);
    expect(registry.list()).toHaveLength(0);
    expect(registry.seed(5)).toHaveLength(5);
  });
});
