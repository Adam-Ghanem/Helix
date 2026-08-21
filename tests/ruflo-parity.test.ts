import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry } from '../packages/models/src/index.js';
import { EventStore } from '../packages/durable/src/index.js';
import { RoutingEvidenceStore } from '../packages/router/src/evidence.js';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentRouter } from '../packages/router/src/index.js';

test('model registry discovers, filters, and toggles provider models', () => {
  const registry = new ModelRegistry();
  registry.discover({ provider: 'test-provider', discoveredAt: new Date().toISOString(), models: [
    { id: 'reasoner', provider: 'ignored', model: 'reasoner-v1', capabilities: ['chat', 'reasoning', 'tool-use'], contextWindow: 32_000, enabled: true },
    { id: 'embedder', provider: 'ignored', model: 'embed-v1', capabilities: ['embeddings'], contextWindow: 8_000, enabled: true },
  ] });
  assert.equal(registry.list({ provider: 'test-provider', capability: 'reasoning', enabledOnly: true }).length, 1);
  registry.disable('reasoner');
  assert.equal(registry.list({ enabledOnly: true }).length, 1);
  registry.enable('reasoner');
  assert.equal(registry.get('reasoner').provider, 'test-provider');
});

test('routing evidence persists outcomes and produces agent summaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-routing-evidence-'));
  try {
    const store = new EventStore({ directory, streamName: 'routing' });
    const evidence = new RoutingEvidenceStore(store);
    const agents = new AgentRegistry(false);
    const agent = agents.register({ name: 'route-a', role: 'worker', capabilities: ['analysis'] });
    const router = new AgentRouter();
    const request = { taskType: 'analysis', requiredCapabilities: ['analysis'], complexity: 0.5 };
    const decision = router.route(request, [{ agent: agents.get(agent.id), estimatedCostUsd: 0.01, availability: 1, memoryRelevance: 1 }]);
    await evidence.record({ request, decision, executionId: 'ex-1', taskId: 'task-1', outcome: { success: true, quality: 0.9, latencyMs: 120, costUsd: 0.01 } });
    const restored = new RoutingEvidenceStore(new EventStore({ directory, streamName: 'routing' }));
    const summary = await restored.summary();
    assert.equal(summary.get(agent.id)?.samples, 1);
    assert.equal(summary.get(agent.id)?.successRate, 1);
    assert.equal((await restored.list(agent.id)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
