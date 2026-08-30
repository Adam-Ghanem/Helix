import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../packages/memory/src/index.js';
import { HttpEmbeddingProvider, PersistentVectorIndex, type EmbeddingProvider } from '../packages/vector/src/index.js';

class SemanticTestEmbeddings implements EmbeddingProvider {
  readonly name = 'semantic-test';
  readonly dimensions = 3;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes('coordinate agents') || normalized.includes('orchestration architecture') || normalized.includes('private swarm')) return [1, 0, 0];
      if (normalized.includes('cook dinner')) return [0, 1, 0];
      return [0, 0, 1];
    });
  }
}

test('persistent vector index applies namespace and subject ACLs before ranking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-vector-'));
  try {
    const stateFile = join(directory, 'vectors.json');
    const index = new PersistentVectorIndex(stateFile);
    await index.upsertMany([
      { id: 'visible', namespace: 'project', owner: 'agent-a', allowedSubjects: [], embedding: [1, 0], metadata: { label: 'visible' }, updatedAt: new Date().toISOString() },
      { id: 'shared', namespace: 'project', owner: 'agent-b', allowedSubjects: ['agent-a'], embedding: [0.9, 0.1], metadata: { label: 'shared' }, updatedAt: new Date().toISOString() },
      { id: 'secret', namespace: 'project', owner: 'agent-b', allowedSubjects: [], embedding: [1, 0], metadata: { label: 'secret' }, updatedAt: new Date().toISOString() },
      { id: 'other-namespace', namespace: 'other', owner: 'agent-a', allowedSubjects: ['*'], embedding: [1, 0], metadata: {}, updatedAt: new Date().toISOString() },
    ]);
    const hits = await index.search({ embedding: [1, 0], namespace: 'project', subject: 'agent-a', limit: 10 });
    assert.deepEqual(hits.map((hit) => hit.id), ['visible', 'shared']);

    const restored = new PersistentVectorIndex(stateFile);
    assert.equal(await restored.count('project'), 3);
    assert.deepEqual((await restored.search({ embedding: [1, 0], namespace: 'project', subject: 'agent-a' })).map((hit) => hit.id), ['visible', 'shared']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('memory hybrid search retrieves semantic matches without lexical overlap and preserves ACLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-hybrid-memory-'));
  try {
    const memory = new MemoryStore({ directory, embeddingProvider: new SemanticTestEmbeddings(), vectorMinimumScore: 0.2 });
    const semantic = await memory.store({ namespace: 'project', owner: 'agent-a', content: 'Coordinate agents through durable task graphs', importance: 0.8, confidence: 0.9, source: { executionId: 'ex-1' }, allowedSubjects: [] });
    await memory.store({ namespace: 'project', owner: 'agent-a', content: 'Cook dinner with vegetables', importance: 1, confidence: 1, source: {}, allowedSubjects: [] });
    await memory.store({ namespace: 'project', owner: 'agent-secret', content: 'Private swarm coordination strategy', importance: 1, confidence: 1, source: {}, allowedSubjects: [] });

    const hits = await memory.search({ query: 'orchestration architecture', namespace: 'project', subject: 'agent-a', limit: 5 });
    assert.equal(hits[0]?.record.id, semantic.id);
    assert.equal(hits[0]?.lexicalScore, 0);
    assert.equal(hits[0]?.vectorScore, 1);
    assert.equal(hits.some((hit) => hit.record.owner === 'agent-secret'), false);

    const restored = new MemoryStore({ directory, embeddingProvider: new SemanticTestEmbeddings(), vectorMinimumScore: 0.2 });
    const restoredHits = await restored.search({ query: 'orchestration architecture', namespace: 'project', subject: 'agent-a' });
    assert.equal(restoredHits[0]?.record.id, semantic.id);
    assert.equal(restored.embeddingProviderName(), 'semantic-test');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('memory consolidation removes expired records from lexical and vector retrieval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-memory-expiry-'));
  try {
    const memory = new MemoryStore({ directory, embeddingProvider: new SemanticTestEmbeddings(), vectorMinimumScore: 0.2 });
    const expired = await memory.store({ namespace: 'project', owner: 'agent-a', content: 'Coordinate agents through durable task graphs', importance: 1, confidence: 1, source: {}, expiresAt: new Date(Date.now() - 1_000).toISOString(), allowedSubjects: [] });
    assert.equal((await memory.search({ query: 'orchestration architecture', namespace: 'project', subject: 'agent-a' })).some((hit) => hit.record.id === expired.id), false);
    assert.equal(await memory.consolidate('project', 'agent-a'), 1);
    const restored = new MemoryStore({ directory, embeddingProvider: new SemanticTestEmbeddings(), vectorMinimumScore: 0.2 });
    assert.equal((await restored.search({ query: 'orchestration architecture', namespace: 'project', subject: 'agent-a' })).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP embedding provider calls an OpenAI-compatible embeddings endpoint', async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/embeddings');
    assert.equal(request.headers.authorization, 'Bearer embedding-key');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; input?: string[]; dimensions?: number };
    assert.equal(payload.model, 'embedding-model');
    assert.deepEqual(payload.input, ['one', 'two']);
    assert.equal(payload.dimensions, 3);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const provider = new HttpEmbeddingProvider({ endpoint: `http://127.0.0.1:${address.port}`, apiKey: 'embedding-key', model: 'embedding-model', dimensions: 3, timeoutMs: 1_000 });
    assert.deepEqual(await provider.embed(['one', 'two']), [[1, 0, 0], [0, 1, 0]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
