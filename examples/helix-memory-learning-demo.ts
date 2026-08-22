import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentRouter } from '../packages/router/src/index.js';
import { MemoryStore } from '../packages/memory/src/index.js';
import { PersistentLearningEngine } from '../packages/learning/src/index.js';

const directory = await mkdtemp(join(tmpdir(), 'helix-memory-demo-'));
try {
  const agents = new AgentRegistry(false);
  for (let index = 0; index < 100; index += 1) agents.register({ name: `agent-${index}`, role: 'demo-worker', capabilities: index % 2 === 0 ? ['analysis', 'testing'] : ['analysis', 'security'] });
  const profiles = agents.list();
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  const router = new AgentRouter();
  const request = { taskType: 'security-analysis', requiredCapabilities: ['analysis'], complexity: 0.5 };
  const candidates = profiles.map((agent) => ({ agent, estimatedCostUsd: 0, availability: 1, memoryRelevance: 0.5 }));
  const initial = router.route(request, candidates, 'adaptive');
  let successCount = 0;
  for (let index = 0; index < 1_000; index += 1) {
    const agent = profiles[index % profiles.length]!;
    const success = agent.capabilities.includes('security') ? index % 5 !== 0 : index % 3 === 0;
    if (success) successCount += 1;
    await (success ? learning.recordSuccess({ executionId: 'demo', taskId: `task-${index}`, taskType: request.taskType, agentId: agent.id, capabilities: ['analysis', 'security'], success: true, quality: 0.8, executionTimeMs: 5 + (index % 20), attempts: 1 }) : learning.recordFailure({ executionId: 'demo', taskId: `task-${index}`, taskType: request.taskType, agentId: agent.id, capabilities: ['analysis', 'security'], success: false, quality: 0, executionTimeMs: 5 + (index % 20), attempts: 1, error: 'deterministic capability mismatch' }));
  }
  const scores = await learning.routingScores(request, candidates);
  const learned = router.route(request, candidates.map((candidate) => ({ ...candidate, learningBonus: scores.get(candidate.agent.id) ?? 0 })), 'adaptive');
  const hints = await learning.suggestRouting(request);
  const stats = await memory.stats();
  console.log(JSON.stringify({ initialRouting: initial, learnedRouting: learned, successRate: successCount / 1_000, memoryCount: stats.count, mostUsefulPatterns: hints.reasons.slice(0, 5), agentsImprovedByExperience: hints.preferredAgents.slice(0, 5), repeatedFailureAgents: hints.avoidAgents, routingChanged: initial.agentId !== learned.agentId }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
