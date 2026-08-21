import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, LearningLoop } from '../packages/memory/src/index.js';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentScheduler } from '../packages/scheduler/src/index.js';

test('learning loop stores and recalls successful execution patterns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-memory-'));
  try {
    const memory = new MemoryStore(directory);
    const learning = new LearningLoop(memory);
    const registry = new AgentRegistry(false);
    const agent = registry.register({ name: 'coder-test', role: 'coder', capabilities: ['coding'] });
    const scheduler = new AgentScheduler(registry);
    const task = scheduler.enqueue({ title: 'Implement API', description: 'implement a TypeScript API endpoint', requiredCapabilities: ['coding'], priority: 8 });
    scheduler.tick();
    const assigned = scheduler.listTasks()[0];
    assert.ok(assigned?.assignedAgentId);
    scheduler.start(task.id);
    scheduler.complete(task.id, true);
    await learning.recordOutcome({ task, agentId: agent.id, success: true, quality: 0.95, summary: 'API implementation passed tests' });
    const hits = await learning.recall(task, '*');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.record.source.agentId, agent.id);
    const hints = await learning.hints(task);
    assert.equal(hints[0]?.agentId, agent.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
