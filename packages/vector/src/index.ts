import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number | undefined;
  embed(texts: string[]): Promise<number[][]>;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash-local';
  readonly dimensions: number;

  constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 32 || dimensions > 4096) throw new Error('Hash embedding dimensions must be an integer from 32 to 4096');
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashEmbedding(text, this.dimensions));
  }
}

export interface HttpEmbeddingProviderOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs?: number;
  name?: string;
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number | undefined;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: HttpEmbeddingProviderOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.name = options.name ?? 'openai-compatible-embeddings';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts, ...(this.dimensions ? { dimensions: this.dimensions } : {}) }),
      });
      if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ index?: number; embedding?: unknown }> };
      if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error('Embedding provider returned an unexpected result count');
      const ordered = [...payload.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      return ordered.map((item, index) => validateEmbedding(item.embedding, `embedding ${index}`));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`Embedding provider timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface VectorRecord {
  id: string;
  namespace: string;
  owner: string;
  allowedSubjects: string[];
  embedding: number[];
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface VectorSearchQuery {
  embedding: number[];
  namespace: string;
  subject: string;
  limit?: number;
  minimumScore?: number;
}

export interface VectorHit {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export class PersistentVectorIndex {
  private readonly records = new Map<string, VectorRecord>();
  private readonly stateFile: string;
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(stateFile: string) {
    this.stateFile = stateFile;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.stateFile), { recursive: true });
    try {
      const persisted = JSON.parse(await readFile(this.stateFile, 'utf8')) as VectorRecord[];
      if (!Array.isArray(persisted)) throw new Error('Vector index state must be an array');
      for (const record of persisted) {
        validateEmbedding(record.embedding, `record ${record.id}`);
        this.records.set(record.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async has(id: string): Promise<boolean> {
    await this.init();
    return this.records.has(id);
  }

  async upsert(input: VectorRecord): Promise<void> {
    return this.upsertMany([input]);
  }

  async upsertMany(inputs: VectorRecord[]): Promise<void> {
    if (!inputs.length) return;
    await this.init();
    const records = inputs.map((input) => ({
      ...input,
      embedding: validateEmbedding(input.embedding, `record ${input.id}`),
      allowedSubjects: [...new Set(input.allowedSubjects)],
      metadata: structuredClone(input.metadata),
    }));
    const dimensions = records[0]?.embedding.length;
    if (!dimensions || records.some((record) => record.embedding.length !== dimensions)) throw new Error('Vector batch contains inconsistent embedding dimensions');
    await this.enqueue(async () => {
      for (const record of records) this.records.set(record.id, record);
      await this.persist();
    });
  }

  async remove(id: string): Promise<boolean> {
    await this.init();
    let removed = false;
    await this.enqueue(async () => {
      removed = this.records.delete(id);
      if (removed) await this.persist();
    });
    return removed;
  }

  async search(query: VectorSearchQuery): Promise<VectorHit[]> {
    await this.init();
    const queryEmbedding = validateEmbedding(query.embedding, 'query embedding');
    const minimumScore = query.minimumScore ?? -1;
    const hits: VectorHit[] = [];
    for (const record of this.records.values()) {
      if (record.namespace !== query.namespace) continue;
      if (record.owner !== query.subject && !record.allowedSubjects.includes('*') && !record.allowedSubjects.includes(query.subject)) continue;
      if (record.embedding.length !== queryEmbedding.length) continue;
      const score = cosineSimilarity(queryEmbedding, record.embedding);
      if (score < minimumScore) continue;
      hits.push({ id: record.id, score, metadata: structuredClone(record.metadata) });
    }
    hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    return hits.slice(0, query.limit ?? 20);
  }

  async count(namespace?: string): Promise<number> {
    await this.init();
    if (!namespace) return this.records.size;
    return [...this.records.values()].filter((record) => record.namespace === namespace).length;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.records.values()], null, 2), 'utf8');
    await rename(temporary, this.stateFile);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2);
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const primary = digest.readUInt32BE(0) % dimensions;
    const secondary = digest.readUInt32BE(4) % dimensions;
    const sign = (digest[8] ?? 0) % 2 === 0 ? 1 : -1;
    vector[primary] = (vector[primary] ?? 0) + sign;
    vector[secondary] = (vector[secondary] ?? 0) + sign * 0.5;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

function validateEmbedding(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) throw new Error(`${label} must be a non-empty finite number array`);
  return [...value];
}
