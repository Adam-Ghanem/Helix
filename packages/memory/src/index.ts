import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Id, id, timestamp } from '../../core/src/index.js';
import { EmbeddingProvider, HashEmbeddingProvider, PersistentVectorIndex } from '../../vector/src/index.js';

export interface MemoryRecord {
  id: Id;
  namespace: string;
  owner: string;
  content: string;
  importance: number;
  confidence: number;
  source: { executionId?: string; agentId?: string; tool?: string; uri?: string };
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  allowedSubjects: string[];
}

export interface MemoryQuery {
  query: string;
  namespace: string;
  subject: string;
  limit?: number;
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  matchedTerms: string[];
}

export interface MemoryStoreOptions {
  directory: string;
  embeddingProvider?: EmbeddingProvider;
  lexicalWeight?: number;
  vectorWeight?: number;
  importanceWeight?: number;
  confidenceWeight?: number;
  vectorMinimumScore?: number;
}

export class MemoryStore {
  private readonly file: string;
  private readonly directory: string;
  private readonly records = new Map<Id, MemoryRecord>();
  private readonly embeddings: EmbeddingProvider;
  private readonly vectors: PersistentVectorIndex;
  private readonly lexicalWeight: number;
  private readonly vectorWeight: number;
  private readonly importanceWeight: number;
  private readonly confidenceWeight: number;
  private readonly vectorMinimumScore: number;
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(directoryOrOptions: string | MemoryStoreOptions) {
    const options: MemoryStoreOptions = typeof directoryOrOptions === 'string' ? { directory: directoryOrOptions } : directoryOrOptions;
    this.directory = options.directory;
    this.file = join(options.directory, 'memory.records.jsonl');
    this.embeddings = options.embeddingProvider ?? new HashEmbeddingProvider();
    this.vectors = new PersistentVectorIndex(join(options.directory, 'memory.vectors.json'));
    this.lexicalWeight = options.lexicalWeight ?? 0.50;
    this.vectorWeight = options.vectorWeight ?? 0.30;
    this.importanceWeight = options.importanceWeight ?? 0.12;
    this.confidenceWeight = options.confidenceWeight ?? 0.08;
    this.vectorMinimumScore = options.vectorMinimumScore ?? 0.05;
    const total = this.lexicalWeight + this.vectorWeight + this.importanceWeight + this.confidenceWeight;
    if (Math.abs(total - 1) > 1e-9) throw new Error('Memory ranking weights must sum to 1');
    for (const [name, value] of Object.entries({ lexicalWeight: this.lexicalWeight, vectorWeight: this.vectorWeight, importanceWeight: this.importanceWeight, confidenceWeight: this.confidenceWeight })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
    }
    if (!Number.isFinite(this.vectorMinimumScore) || this.vectorMinimumScore < -1 || this.vectorMinimumScore > 1) throw new Error('vectorMinimumScore must be between -1 and 1');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true });
    try {
      const contents = await readFile(this.file, 'utf8');
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as MemoryRecord;
        this.records.set(record.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.vectors.init();
    await this.reindexMissing();
    this.initialized = true;
  }

  async store(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    await this.init();
    const now = timestamp();
    const record: MemoryRecord = { ...input, id: id('mem'), createdAt: now, updatedAt: now, allowedSubjects: [...new Set(input.allowedSubjects)] };
    const [embedding] = await this.embeddings.embed([this.embeddingText(record)]);
    if (!embedding) throw new Error('Embedding provider returned no vector for memory record');
    await this.vectors.upsert(this.vectorRecord(record, embedding));
    try {
      await this.enqueue(async () => {
        await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
        this.records.set(record.id, record);
      });
    } catch (error) {
      await this.vectors.remove(record.id);
      throw error;
    }
    return structuredClone(record);
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    await this.init();
    const terms = this.terms(query.query);
    const now = Date.now();
    const candidates = new Map<string, { record: MemoryRecord; lexicalScore: number; vectorScore: number; matchedTerms: string[] }>();

    for (const record of this.records.values()) {
      if (!this.visible(record, query.namespace, query.subject, now)) continue;
      const haystack = `${record.content} ${record.source.uri ?? ''}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const lexicalScore = terms.length ? matchedTerms.length / terms.length : 0;
      if (!terms.length || matchedTerms.length) candidates.set(record.id, { record, lexicalScore, vectorScore: 0, matchedTerms });
    }

    if (query.query.trim()) {
      const [queryEmbedding] = await this.embeddings.embed([query.query]);
      if (!queryEmbedding) throw new Error('Embedding provider returned no vector for memory query');
      const vectorHits = await this.vectors.search({
        embedding: queryEmbedding,
        namespace: query.namespace,
        subject: query.subject,
        limit: Math.max((query.limit ?? 20) * 4, 50),
        minimumScore: this.vectorMinimumScore,
      });
      for (const hit of vectorHits) {
        const record = this.records.get(hit.id);
        if (!record || !this.visible(record, query.namespace, query.subject, now)) continue;
        const existing = candidates.get(record.id);
        if (existing) existing.vectorScore = Math.max(0, hit.score);
        else candidates.set(record.id, { record, lexicalScore: 0, vectorScore: Math.max(0, hit.score), matchedTerms: [] });
      }
    }

    const hits: MemoryHit[] = [...candidates.values()].map(({ record, lexicalScore, vectorScore, matchedTerms }) => ({
      record: structuredClone(record),
      lexicalScore,
      vectorScore,
      matchedTerms,
      score: this.lexicalWeight * lexicalScore + this.vectorWeight * vectorScore + this.importanceWeight * clamp01(record.importance) + this.confidenceWeight * clamp01(record.confidence),
    }));
    hits.sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt));
    return hits.slice(0, query.limit ?? 20);
  }

  async consolidate(namespace: string, subject: string): Promise<number> {
    await this.init();
    const now = Date.now();
    let removed = 0;
    const removedIds: string[] = [];
    for (const [recordId, record] of this.records) {
      if (record.namespace === namespace && (record.owner === subject || record.allowedSubjects.includes(subject)) && record.expiresAt && Date.parse(record.expiresAt) <= now) {
        this.records.delete(recordId);
        removedIds.push(recordId);
        removed += 1;
      }
    }
    if (removed) {
      await this.rewrite();
      await Promise.all(removedIds.map((recordId) => this.vectors.remove(recordId)));
    }
    return removed;
  }

  async list(namespace: string, subject: string): Promise<MemoryRecord[]> {
    return (await this.search({ query: '', namespace, subject, limit: Number.MAX_SAFE_INTEGER })).map((hit) => hit.record);
  }

  async reindex(): Promise<number> {
    await this.init();
    return this.indexRecords([...this.records.values()]);
  }

  embeddingProviderName(): string {
    return this.embeddings.name;
  }

  private async reindexMissing(): Promise<number> {
    const missing: MemoryRecord[] = [];
    for (const record of this.records.values()) if (!(await this.vectors.has(record.id))) missing.push(record);
    return this.indexRecords(missing);
  }

  private async indexRecords(records: MemoryRecord[]): Promise<number> {
    if (!records.length) return 0;
    const embeddings = await this.embeddings.embed(records.map((record) => this.embeddingText(record)));
    if (embeddings.length !== records.length) throw new Error('Embedding provider returned an unexpected memory vector count');
    await this.vectors.upsertMany(records.map((record, index) => {
      const embedding = embeddings[index];
      if (!embedding) throw new Error(`Embedding provider returned no vector for memory ${record.id}`);
      return this.vectorRecord(record, embedding);
    }));
    return records.length;
  }

  private vectorRecord(record: MemoryRecord, embedding: number[]) {
    return {
      id: record.id,
      namespace: record.namespace,
      owner: record.owner,
      allowedSubjects: record.allowedSubjects,
      embedding,
      metadata: { source: record.source, importance: record.importance, confidence: record.confidence },
      updatedAt: record.updatedAt,
    };
  }

  private embeddingText(record: MemoryRecord): string {
    return `${record.content}\n${record.source.uri ?? ''}`.trim();
  }

  private visible(record: MemoryRecord, namespace: string, subject: string, now: number): boolean {
    if (record.namespace !== namespace) return false;
    if (record.owner !== subject && !record.allowedSubjects.includes('*') && !record.allowedSubjects.includes(subject)) return false;
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) return false;
    return true;
  }

  private terms(query: string): string[] {
    return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))];
  }

  private async rewrite(): Promise<void> {
    await this.enqueue(async () => {
      await writeFile(this.file, [...this.records.values()].map((record) => JSON.stringify(record)).join('\n') + (this.records.size ? '\n' : ''), 'utf8');
    });
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
