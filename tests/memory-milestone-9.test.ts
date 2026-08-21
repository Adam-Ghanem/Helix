import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentRouter } from '../packages/router/src/index.js';
import { MemoryStore, DeterministicEmbeddingProvider, type MemoryEntryInput } from '../packages/memory/src/index.js';
import { PersistentLearningEngine } from '../packages/learning/src/index.js';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { ToolRegistry } from '../packages/tools/src/index.js';

function input(namespace: MemoryEntryInput['namespace'], owner: string, content: string, overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return { namespace, type: 'fact', content, metadata: { domain: 'test', version: 1 }, source: 'test', confidence: 0.9, tags: ['test'], provenance: { sourceType: 'user', sourceId: 'test-source', timestamp: new Date().toISOString(), confidence: 0.9 }, accessPolicy: { visibility: 'private', allowedSubjects: [owner], allowedSwarmIds: [], owner }, ...overrides };
}

async function withDirectory<T>(prefix: string, operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { return await operation(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('M9 memory create and get preserve a strong entry domain', async () => withDirectory('helix-m9-create-', async (directory) => {
  const memory = new MemoryStore(directory);
  const entry = await memory.create(input('global', 'alice', 'TypeScript authentication fact'), { subject: 'alice' });
  const restored = await memory.get(entry.id, { subject: 'alice' });
  assert.equal(restored.type, 'fact');
  assert.equal(restored.provenance.sourceId, 'test-source');
  assert.deepEqual(restored.tags, ['test']);
}));

test('M9 memory update and delete enforce ownership', async () => withDirectory('helix-m9-crud-', async (directory) => {
  const memory = new MemoryStore(directory);
  const entry = await memory.create(input('global', 'alice', 'old content'), { subject: 'alice' });
  const updated = await memory.update(entry.id, { content: 'new content', confidence: 0.8 }, { subject: 'alice' });
  assert.equal(updated.content, 'new content');
  await assert.rejects(() => memory.update(entry.id, { content: 'blocked' }, { subject: 'bob' }), /not authorized/);
  await memory.delete(entry.id, { subject: 'alice' });
  await assert.rejects(() => memory.get(entry.id), /Unknown memory/);
}));

test('M9 namespace isolation permits global and authorized swarm reads only', async () => withDirectory('helix-m9-ns-', async (directory) => {
  const memory = new MemoryStore(directory);
  await memory.create(input('agent:agent-a', 'agent-a', 'private A'), { subject: 'agent-a', agentId: 'agent-a' });
  await memory.create(input('swarm:swarm-a', 'agent-a', 'shared swarm A', { accessPolicy: { visibility: 'shared', allowedSubjects: [], allowedSwarmIds: ['swarm-a'], owner: 'agent-a' }, swarmId: 'swarm-a' }), { subject: 'agent-a', agentId: 'agent-a', swarmIds: ['swarm-a'] });
  assert.equal((await memory.listEntries({ subject: 'agent-b', agentId: 'agent-b' })).length, 0);
  assert.equal((await memory.listEntries({ subject: 'agent-b', agentId: 'agent-b', swarmIds: ['swarm-a'] })).length, 1);
}));

test('M9 ACL blocks private agent memory and permits explicit public access', async () => withDirectory('helix-m9-acl-', async (directory) => {
  const memory = new MemoryStore(directory);
  const privateEntry = await memory.create(input('agent:agent-a', 'agent-a', 'private'), { subject: 'agent-a', agentId: 'agent-a' });
  const publicEntry = await memory.create(input('global', 'system', 'public', { accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  await assert.rejects(() => memory.get(privateEntry.id, { subject: 'agent-b', agentId: 'agent-b' }), /not authorized/);
  assert.equal((await memory.get(publicEntry.id, { subject: 'agent-b', agentId: 'agent-b' })).content, 'public');
}));

test('M9 provenance and confidence remain inspectable', async () => withDirectory('helix-m9-prov-', async (directory) => {
  const memory = new MemoryStore(directory);
  const entry = await memory.create(input('global', 'alice', 'provenance', { type: 'solution', confidence: 0.77, provenance: { sourceType: 'task-outcome', sourceId: 'task-1', timestamp: '2026-08-21T00:00:00.000Z', confidence: 0.73, agentId: 'agent-a', taskId: 'task-1' } }), { subject: 'alice' });
  assert.equal(entry.provenance.sourceType, 'task-outcome');
  assert.equal(entry.provenance.taskId, 'task-1');
  assert.equal(entry.confidence, 0.77);
}));

test('M9 keyword search returns matched terms and explanation', async () => withDirectory('helix-m9-keyword-', async (directory) => {
  const memory = new MemoryStore(directory);
  await memory.create(input('global', 'system', 'TypeScript authentication debugging', { accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  const results = await memory.searchEntries({ query: 'TypeScript authentication', context: { subject: 'reader' } });
  assert.equal(results.length, 1);
  assert.ok(results[0]?.matchedBy.some((item) => item.startsWith('keyword:')));
  assert.match(results[0]?.explanation ?? '', /semantic=/);
}));

test('M9 deterministic semantic search is repeatable without external models', async () => {
  const provider = new DeterministicEmbeddingProvider();
  const first = await provider.embed('authentication TypeScript');
  const second = await provider.embed('authentication TypeScript');
  assert.deepEqual(first, second);
  assert.equal(first.length, 32);
});

test('M9 hybrid ranking favors relevant high-confidence evidence transparently', async () => withDirectory('helix-m9-ranking-', async (directory) => {
  const memory = new MemoryStore(directory);
  await memory.create(input('global', 'system', 'authentication bug fix TypeScript', { confidence: 0.95, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  await memory.create(input('global', 'system', 'unrelated deployment note', { confidence: 0.2, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  const results = await memory.searchEntries({ query: 'authentication TypeScript', context: { subject: 'reader' } });
  assert.equal(results[0]?.entry.content, 'authentication bug fix TypeScript');
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
}));

test('M9 metadata, type, tag, and confidence filters narrow results', async () => withDirectory('helix-m9-filter-', async (directory) => {
  const memory = new MemoryStore(directory);
  await memory.create(input('global', 'system', 'secure solution', { type: 'solution', metadata: { domain: 'security', version: 2 }, tags: ['security'], confidence: 0.9, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  await memory.create(input('global', 'system', 'weak fact', { confidence: 0.3, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  const results = await memory.searchEntries({ query: 'secure', types: ['solution'], tags: ['security'], metadata: { domain: 'security' }, minScore: 0.5, context: { subject: 'reader' } });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.entry.type, 'solution');
}));

test('M9 recency decay is configurable and affects scores without deleting memories', async () => withDirectory('helix-m9-decay-', async (directory) => {
  const memory = new MemoryStore(directory);
  const entry = await memory.create(input('global', 'system', 'old routing evidence', { accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  const future = new Date(Date.parse(entry.updatedAt) + 90 * 86_400_000).toISOString();
  const short = await memory.searchEntries({ query: 'old routing', halfLifeDays: 7, now: future, context: { subject: 'reader' } });
  const long = await memory.searchEntries({ query: 'old routing', halfLifeDays: 90, now: future, context: { subject: 'reader' } });
  assert.ok((long[0]?.score ?? 0) > (short[0]?.score ?? 0));
  assert.equal(await memory.count(), 1);
}));

test('M9 successful task learning creates solution, routing, and agent experience memories', async () => withDirectory('helix-m9-success-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  const entries = await learning.recordSuccess({ executionId: 'ex-1', taskId: 'task-1', taskType: 'typescript-auth', agentId: 'agent-a', capabilities: ['typescript', 'security'], success: true, quality: 0.95, executionTimeMs: 120, attempts: 1, output: { ok: true } });
  assert.equal(entries.length, 3);
  assert.equal((await memory.searchEntries({ query: 'worked typescript-auth', context: { subject: 'reader' } })).length > 0, true);
}));

test('M9 failed task learning stores a failure category and retry evidence', async () => withDirectory('helix-m9-failure-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  await learning.recordFailure({ executionId: 'ex-1', taskId: 'task-1', taskType: 'network-review', agentId: 'agent-a', capabilities: ['network'], success: false, quality: 0, executionTimeMs: 300, attempts: 2, error: 'network timeout during retry' });
  const results = await memory.searchEntries({ query: 'network timeout', types: ['failure', 'pattern'], context: { subject: 'reader' } });
  assert.equal(results.length > 0, true);
  assert.equal(results[0]?.entry.metadata.errorCategory, 'timeout');
}));

test('M9 routing hints prefer successful agents and explain the signal', async () => withDirectory('helix-m9-hints-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  await learning.recordSuccess({ executionId: 'ex-1', taskId: 'task-1', taskType: 'auth-debug', agentId: 'agent-a', capabilities: ['security', 'debugging'], success: true, quality: 0.95, executionTimeMs: 20, attempts: 1 });
  const hints = await learning.suggestRouting({ taskType: 'auth-debug', requiredCapabilities: ['security'], complexity: 0.5 });
  assert.equal(hints.preferredAgents[0], 'agent-a');
  assert.ok(hints.reasons[0]?.includes('successes'));
}));

test('M9 learning bonus is bounded at ten percent of routing score', async () => withDirectory('helix-m9-bonus-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory, { maxLearningBonus: 0.5 });
  await learning.recordSuccess({ executionId: 'ex-1', taskId: 'task-1', taskType: 'review', agentId: 'agent-a', capabilities: ['analysis'], success: true, quality: 1, executionTimeMs: 1, attempts: 1 });
  const agents = new AgentRegistry(false);
  const first = agents.register({ name: 'a', role: 'review', capabilities: ['analysis'] });
  const second = agents.register({ name: 'b', role: 'review', capabilities: ['analysis'] });
  const candidates = [{ agent: agents.get(first.id), estimatedCostUsd: 0, availability: 1, memoryRelevance: 0.5 }, { agent: agents.get(second.id), estimatedCostUsd: 0, availability: 1, memoryRelevance: 0.5 }];
  const scores = await learning.routingScores({ taskType: 'review', requiredCapabilities: ['analysis'], complexity: 0.5 }, candidates);
  assert.ok(Math.abs(scores.get(first.id) ?? 0) <= 0.1);
}));

test('M9 capability mismatch cannot be overridden by learning', () => {
  const agents = new AgentRegistry(false);
  const compatible = agents.register({ name: 'compatible', role: 'worker', capabilities: ['security'] });
  const incompatible = agents.register({ name: 'incompatible', role: 'worker', capabilities: ['analysis'] });
  const router = new AgentRouter();
  const result = router.route({ taskType: 'security', requiredCapabilities: ['security'], complexity: 1 }, [{ agent: agents.get(incompatible.id), estimatedCostUsd: 0, availability: 1, memoryRelevance: 1, learningBonus: 0.1 }, { agent: agents.get(compatible.id), estimatedCostUsd: 0, availability: 1, memoryRelevance: 0, learningBonus: -0.1 }]);
  assert.equal(result.agentId, compatible.id);
  assert.equal(result.rationale.some((item) => item.startsWith('capabilities=1.00')), true);
});

test('M9 repeated failures create a temporary avoid signal rather than permanent blacklist', async () => withDirectory('helix-m9-avoid-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  for (let index = 1; index <= 3; index += 1) await learning.recordFailure({ executionId: 'ex-1', taskId: `task-${index}`, taskType: 'repeat-failure', agentId: 'agent-a', capabilities: ['analysis'], success: false, quality: 0, executionTimeMs: 10, attempts: index, error: 'permission denied' });
  const hints = await learning.suggestRouting({ taskType: 'repeat-failure', requiredCapabilities: ['analysis'], complexity: 0.5 });
  assert.deepEqual(hints.avoidAgents, ['agent-a']);
  assert.equal((await memory.count()) > 0, true);
}));

test('M9 sanitization removes secret keys and credential-like values before persistence', async () => withDirectory('helix-m9-sanitize-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  await learning.recordSuccess({ executionId: 'ex-secret', taskId: 'task-secret', taskType: 'secret-test', agentId: 'agent-a', capabilities: ['security'], success: true, quality: 0.8, executionTimeMs: 1, attempts: 1, output: { apiKey: `sk-${'abcdefghijklmnopqrstuvwxyz123456'}`, authorization: `Bearer ${'top-secret-value'}`, safe: 'ok' } });
  const file = await readFile(join(directory, 'memory.records.jsonl'), 'utf8');
  assert.equal(file.includes(`sk-${'abcdefghijklmnopqrstuvwxyz123456'}`), false);
  assert.equal(file.includes('top-secret-value'), false);
  assert.equal(file.includes('[redacted-secret]'), true);
}));

test('M9 agent experience accumulates historical counts and associations', async () => withDirectory('helix-m9-experience-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  await learning.recordSuccess({ executionId: 'ex-1', taskId: 't-1', taskType: 'typescript', agentId: 'agent-a', capabilities: ['typescript'], success: true, quality: 0.9, executionTimeMs: 100, attempts: 1 });
  await learning.recordFailure({ executionId: 'ex-1', taskId: 't-2', taskType: 'typescript', agentId: 'agent-a', capabilities: ['typescript'], success: false, quality: 0, executionTimeMs: 200, attempts: 1, error: 'timeout' });
  const experience = await learning.getAgentExperience('agent-a');
  assert.equal(experience.successfulTaskCount, 1);
  assert.equal(experience.failedTaskCount, 1);
  assert.equal(experience.capabilityTaskAssociations.typescript, 2);
}));

test('M9 swarm memory remains isolated by membership', async () => withDirectory('helix-m9-swarm-', async (directory) => {
  const memory = new MemoryStore(directory);
  await memory.create(input('swarm:swarm-a', 'agent-a', 'swarm secret', { swarmId: 'swarm-a', accessPolicy: { visibility: 'shared', allowedSubjects: [], allowedSwarmIds: ['swarm-a'], owner: 'agent-a' } }), { subject: 'agent-a', agentId: 'agent-a', swarmIds: ['swarm-a'] });
  assert.equal((await memory.searchEntries({ query: 'swarm secret', context: { subject: 'agent-b', agentId: 'agent-b', swarmIds: ['swarm-b'] } })).length, 0);
  assert.equal((await memory.searchEntries({ query: 'swarm secret', context: { subject: 'agent-c', agentId: 'agent-c', swarmIds: ['swarm-a'] } })).length, 1);
}));

test('M9 restart persistence restores new memory entries', async () => withDirectory('helix-m9-restart-', async (directory) => {
  const first = new MemoryStore(directory);
  const entry = await first.create(input('global', 'system', 'restart persistent', { accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' });
  const second = new MemoryStore(directory);
  assert.equal((await second.get(entry.id, { subject: 'reader' })).content, 'restart persistent');
}));

test('M9 concurrent writes serialize and retain every entry', async () => withDirectory('helix-m9-concurrent-', async (directory) => {
  const memory = new MemoryStore(directory);
  await Promise.all(Array.from({ length: 50 }, (_, index) => memory.create(input('global', 'system', `concurrent ${index}`, { metadata: { index }, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }), { subject: 'system' })));
  assert.equal(await memory.count(), 50);
  const restored = new MemoryStore(directory);
  assert.equal(await restored.count(), 50);
}));

test('M9 100 agents learn from many deterministic tasks without LLM calls', async () => withDirectory('helix-m9-scale-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  for (let task = 0; task < 100; task += 1) {
    const agentId = `agent-${task % 100}`;
    await learning.recordSuccess({ executionId: 'scale', taskId: `task-${task}`, taskType: task % 2 === 0 ? 'analysis' : 'testing', agentId, capabilities: ['analysis'], success: true, quality: 0.8, executionTimeMs: task, attempts: 1 });
  }
  assert.equal((await memory.stats()).count, 300);
  const hints = await learning.suggestRouting({ taskType: 'analysis', requiredCapabilities: ['analysis'], complexity: 0.5 });
  assert.equal(hints.preferredAgents.length > 0, true);
}));

test('M9 persistent learning is idempotent for replayed outcomes', async () => withDirectory('helix-m9-idempotent-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  const payload = { executionId: 'ex', taskId: 'task', taskType: 'review', agentId: 'agent', capabilities: ['analysis'], success: true, quality: 0.9, executionTimeMs: 1, attempts: 1 };
  assert.equal((await learning.recordSuccess(payload)).length, 3);
  assert.equal((await learning.recordSuccess(payload)).length, 0);
  assert.equal((await memory.count()), 3);
}));

test('M9 sandbox outcomes are sanitized before memory persistence', async () => withDirectory('helix-m9-sandbox-memory-', async (directory) => {
  const memory = new MemoryStore(directory);
  const learning = new PersistentLearningEngine(memory);
  const entry = await learning.recordSandboxResult('ex-sandbox', { stdout: 'safe', env: { API_KEY: `sk-${'abcdefghijklmnopqrstuvwxyz123456'}` } });
  assert.equal(entry.metadata.sanitizedResult?.toString().includes('[redacted-secret]'), true);
  assert.equal((await memory.searchEntries({ query: 'sandbox result', context: { subject: 'reader' } })).length, 1);
}));

test('M9 MCP registration exposes all required memory and learning tools', () => {
  const runtime = new HelixRuntime({ dataDirectory: join(tmpdir(), 'helix-m9-mcp-runtime') });
  const registry = new ToolRegistry();
  const tools = runtime.registerMemoryTools(registry);
  assert.deepEqual(tools.map((tool) => tool.name), ['helix.memory.search', 'helix.memory.get', 'helix.memory.list', 'helix.memory.stats', 'helix.learning.recall', 'helix.learning.routingHints', 'helix.learning.agentExperience']);
  assert.equal(registry.get('helix.memory.search').permissions.includes('memory:read'), true);
});

test('M9 runtime integrates outcome learning while existing deterministic execution remains green', async () => withDirectory('helix-m9-runtime-', async (directory) => {
  const runtime = new HelixRuntime({ dataDirectory: directory });
  const execution = await runtime.execute({ goal: 'M9 learning integration' });
  assert.equal(execution.status, 'completed');
  assert.equal((await runtime.memoryStats()).count >= 12, true);
  assert.ok((await runtime.searchMemory({ query: 'successful', context: { subject: 'reader' } })).length > 0);
}));
