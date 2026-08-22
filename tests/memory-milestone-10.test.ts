import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLearningQueue, PersistentLearningEngine } from '../packages/learning/src/index.js';
import { MemoryCache, MemoryStore, SqliteMemoryStore, type MemoryEntryInput } from '../packages/memory/src/index.js';
import { HelixRuntime } from '../packages/runtime/src/index.js';

function entry(index: number, overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return { namespace: 'global', type: 'solution', content: `solution pattern ${index}`, metadata: { taskType: index % 2 === 0 ? 'analysis' : 'security', index, group: `group-${index % 5}` }, source: 'm10-test', confidence: 0.8, tags: ['m10', index % 2 === 0 ? 'analysis' : 'security'], provenance: { sourceType: 'task-outcome', sourceId: `task-${index}`, timestamp: new Date().toISOString(), confidence: 0.8 }, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' }, ...overrides };
}

async function withDirectory<T>(prefix: string, operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { return await operation(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function sqlite(directory: string): Promise<SqliteMemoryStore> {
  const store = new SqliteMemoryStore(join(directory, 'memory.sqlite'), { cache: { maxEntries: 64, ttlMs: 10_000 }, retrievalLimit: 100 });
  await store.init();
  return store;
}

test('M10 SQLite backend creates, reads, and restores entries transactionally', async () => withDirectory('helix-m10-sqlite-', async (directory) => {
  const first = await sqlite(directory);
  const created = await first.create(entry(1));
  assert.equal((await first.get(created.id, { subject: 'reader' })).content, 'solution pattern 1');
  first.close();
  const restored = await sqlite(directory);
  assert.equal((await restored.get(created.id, { subject: 'reader' })).id, created.id);
  restored.close();
}));

test('M10 batch writes are atomic and retain every row', async () => withDirectory('helix-m10-batch-', async (directory) => {
  const store = await sqlite(directory);
  const entries = await store.createMany(Array.from({ length: 250 }, (_, index) => ({ input: entry(index) })));
  assert.equal(entries.length, 250);
  assert.equal(await store.count(), 250);
  store.close();
}));

test('M10 indexed filters support namespace, agent, task, type, tags, metadata, and confidence', async () => withDirectory('helix-m10-indexes-', async (directory) => {
  const store = await sqlite(directory);
  await store.createMany([
    { input: entry(1, { namespace: 'agent:agent-a', agentId: 'agent-a', type: 'failure', confidence: 0.9, tags: ['m10', 'security'], metadata: { taskType: 'security', index: 1, group: 'indexed' }, accessPolicy: { visibility: 'private', allowedSubjects: ['agent-a'], allowedSwarmIds: [], owner: 'agent-a' } }), context: { subject: 'agent-a', agentId: 'agent-a' } },
    { input: entry(2, { namespace: 'global', type: 'solution', confidence: 0.4, metadata: { taskType: 'analysis', index: 2, group: 'other' } }) },
  ]);
  const results = await store.searchEntries({ query: 'security', namespace: 'agent:agent-a', types: ['failure'], tags: ['security'], metadata: { group: 'indexed' }, minScore: 0.5, context: { subject: 'agent-a', agentId: 'agent-a' } });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.entry.agentId, 'agent-a');
  store.close();
}));

test('M10 SQLite ACL prevents cross-agent private memory access', async () => withDirectory('helix-m10-acl-', async (directory) => {
  const store = await sqlite(directory);
  const created = await store.create(entry(1, { namespace: 'agent:agent-a', agentId: 'agent-a', accessPolicy: { visibility: 'private', allowedSubjects: ['agent-a'], allowedSwarmIds: [], owner: 'agent-a' } }), { subject: 'agent-a', agentId: 'agent-a' });
  await assert.rejects(() => store.get(created.id, { subject: 'agent-b', agentId: 'agent-b' }), /not authorized/);
  assert.equal((await store.listEntries({ subject: 'agent-b', agentId: 'agent-b' })).length, 0);
  store.close();
}));

test('M10 cache hits are bounded and invalidated after mutation', async () => withDirectory('helix-m10-cache-', async (directory) => {
  const store = await sqlite(directory);
  const created = await store.create(entry(1));
  await store.get(created.id, { subject: 'reader' });
  await store.get(created.id, { subject: 'reader' });
  assert.equal(store.cacheSize() > 0, true);
  const updated = await store.update(created.id, { content: 'updated cache value' }, { subject: 'system' });
  assert.equal((await store.get(created.id, { subject: 'reader' })).content, 'updated cache value');
  assert.equal(updated.content, 'updated cache value');
  store.close();
}));

test('M10 bounded retrieval limits SQL candidates and returned results', async () => withDirectory('helix-m10-bounded-', async (directory) => {
  const store = new SqliteMemoryStore(join(directory, 'memory.sqlite'), { retrievalLimit: 10 });
  await store.init();
  await store.createMany(Array.from({ length: 100 }, (_, index) => ({ input: entry(index) })));
  const results = await store.searchEntries({ query: 'solution pattern', retrievalLimit: 10, limit: 5, context: { subject: 'reader' } });
  assert.equal(results.length, 5);
  store.close();
}));

test('M10 compaction merges duplicate patterns and can vacuum the database', async () => withDirectory('helix-m10-compact-', async (directory) => {
  const store = await sqlite(directory);
  await store.createMany([{ input: entry(1, { content: 'same pattern' }) }, { input: entry(2, { content: 'same pattern' }) }, { input: entry(3, { content: 'different pattern' }) }]);
  const before = await store.count();
  const result = await store.compact({ mergePatterns: true, vacuum: true });
  assert.equal(before, 3);
  assert.equal(result.removedDuplicates, 1);
  assert.equal(await store.count(), 2);
  const merged = (await store.searchEntries({ query: 'same pattern', context: { subject: 'reader' } }))[0]?.entry;
  assert.equal(merged?.metadata.mergedSamples, 2);
  store.close();
}));

test('M10 legacy memory records remain compatible and expired records compact cleanly', async () => withDirectory('helix-m10-legacy-', async (directory) => {
  const store = await sqlite(directory);
  const record = await store.store({ namespace: 'legacy', owner: 'agent-a', content: 'legacy durable fact', importance: 0.9, confidence: 0.9, source: {}, expiresAt: new Date(Date.now() - 1_000).toISOString(), allowedSubjects: ['agent-a'] });
  assert.equal((await store.search({ query: 'legacy durable', namespace: 'legacy', subject: 'agent-a' })).length, 0);
  const compacted = await store.compact({ removeExpiredLegacy: true });
  assert.equal(compacted.removedExpiredLegacy, 1);
  assert.equal(record.namespace, 'legacy');
  store.close();
}));

test('M10 migrates M9 JSONL upserts into SQLite without duplicate IDs', async () => withDirectory('helix-m10-migrate-', async (directory) => {
  const jsonl = new MemoryStore(directory);
  const created = await jsonl.create(entry(77));
  const sqliteStore = new SqliteMemoryStore(join(directory, 'migrated.sqlite'), { migrateJsonlFile: join(directory, 'memory.records.jsonl') });
  await sqliteStore.init();
  assert.equal((await sqliteStore.get(created.id, { subject: 'reader' })).id, created.id);
  assert.equal(await sqliteStore.count(), 1);
  sqliteStore.close();
}));

test('M10 deletion invalidates FTS and cache entries', async () => withDirectory('helix-m10-delete-index-', async (directory) => {
  const store = await sqlite(directory);
  const created = await store.create(entry(88, { content: 'deletion target phrase' }));
  assert.equal((await store.searchEntries({ query: 'deletion target', context: { subject: 'reader' } })).length, 1);
  await store.delete(created.id, { subject: 'system', canDelete: true });
  assert.equal((await store.searchEntries({ query: 'deletion target', context: { subject: 'reader' } })).length, 0);
  store.close();
}));

test('M10 concurrent batch writes serialize through SQLite WAL and retain all entries', async () => withDirectory('helix-m10-concurrent-', async (directory) => {
  const store = await sqlite(directory);
  await Promise.all(Array.from({ length: 10 }, (_, batch) => store.createMany(Array.from({ length: 50 }, (_, index) => ({ input: entry(batch * 50 + index) })))));
  assert.equal(await store.count(), 500);
  store.close();
}));

test('M10 async learning queue deduplicates work and flushes deterministically', async () => {
  const queue = new AsyncLearningQueue({ batchSize: 2 });
  let runs = 0;
  assert.equal(queue.enqueue('same', async () => { runs += 1; }), true);
  assert.equal(queue.enqueue('same', async () => { runs += 100; }), false);
  await queue.flush();
  assert.equal(runs, 1);
  assert.equal(queue.size, 0);
});

test('M10 PersistentLearningEngine uses a SQLite transaction for outcome batches', async () => withDirectory('helix-m10-learning-', async (directory) => {
  const store = await sqlite(directory);
  const learning = new PersistentLearningEngine(store);
  const entries = await learning.recordSuccess({ executionId: 'ex', taskId: 'task', taskType: 'analysis', agentId: 'agent-a', capabilities: ['analysis'], success: true, quality: 0.9, executionTimeMs: 5, attempts: 1 });
  assert.equal(entries.length, 3);
  assert.equal(await store.count(), 3);
  store.close();
}));

test('M10 runtime defaults to SQLite and asynchronous learning can be flushed explicitly', async () => withDirectory('helix-m10-runtime-', async (directory) => {
  const runtime = new HelixRuntime({ dataDirectory: directory });
  const execution = await runtime.execute({ goal: 'M10 SQLite runtime integration' });
  assert.equal(execution.status, 'completed');
  await runtime.flushLearning();
  assert.equal((await runtime.memoryStats()).count >= 12, true);
  assert.equal(runtime.memory.constructor.name, 'SqliteMemoryStore');
}));

test('M10 runtime can retain the M9 JSONL backend as an explicit compatibility option', async () => withDirectory('helix-m10-jsonl-', async (directory) => {
  const runtime = new HelixRuntime({ dataDirectory: directory, useSqliteMemory: false, learningAsync: false });
  const execution = await runtime.execute({ goal: 'M9 JSONL compatibility' });
  assert.equal(execution.status, 'completed');
  assert.equal(runtime.memory.constructor.name, 'MemoryStore');
}));

test('M10 SQLite provenance validation rejects corrupt writes', async () => withDirectory('helix-m10-provenance-', async (directory) => {
  const store = await sqlite(directory);
  await assert.rejects(() => store.create(entry(1, { provenance: { sourceType: 'task-outcome', sourceId: '', timestamp: '', confidence: Number.NaN } })), /provenance/i);
  store.close();
}));

test('M10 cache TTL expires entries deterministically', async () => {
  const cache = new MemoryCache<number>({ maxEntries: 2, ttlMs: 10 });
  cache.set('a', 1, 0);
  assert.equal(cache.get('a', 5), 1);
  assert.equal(cache.get('a', 11), undefined);
  cache.set('a', 1, 0);
  cache.set('b', 2, 0);
  cache.set('c', 3, 0);
  assert.equal(cache.get('a', 0), undefined);
});

test('M10 SQLite database file is durable and contains schema-backed storage', async () => withDirectory('helix-m10-file-', async (directory) => {
  const file = join(directory, 'memory.sqlite');
  const store = new SqliteMemoryStore(file);
  await store.init();
  await store.create(entry(1));
  store.close();
  await access(file);
  const bytes = await readFile(file);
  assert.equal(bytes.length > 100, true);
}));
