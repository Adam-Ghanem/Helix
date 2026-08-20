import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Id, id, timestamp } from '../../core/src/index.js';

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
  matchedTerms: string[];
}

export class MemoryStore {
  private readonly file: string;
  private readonly records = new Map<Id, MemoryRecord>();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.file = join(directory, 'memory.records.jsonl');
    this.directory = directory;
  }

  private readonly directory: string;

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
    this.initialized = true;
  }

  async store(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    await this.init();
    const now = timestamp();
    const record: MemoryRecord = { ...input, id: id('mem'), createdAt: now, updatedAt: now, allowedSubjects: [...new Set(input.allowedSubjects)] };
    await this.enqueue(async () => {
      await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
      this.records.set(record.id, record);
    });
    return structuredClone(record);
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    await this.init();
    const terms = this.terms(query.query);
    const now = Date.now();
    const hits: MemoryHit[] = [];
    for (const record of this.records.values()) {
      if (record.namespace !== query.namespace) continue;
      if (record.owner !== query.subject && !record.allowedSubjects.includes('*') && !record.allowedSubjects.includes(query.subject)) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) <= now) continue;
      const haystack = `${record.content} ${record.source.uri ?? ''}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      if (!matchedTerms.length && terms.length) continue;
      const lexical = terms.length ? matchedTerms.length / terms.length : 0;
      const score = 0.65 * lexical + 0.20 * record.importance + 0.15 * record.confidence;
      hits.push({ record: structuredClone(record), score, matchedTerms });
    }
    hits.sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt));
    return hits.slice(0, query.limit ?? 20);
  }

  async consolidate(namespace: string, subject: string): Promise<number> {
    await this.init();
    const now = Date.now();
    let removed = 0;
    for (const [recordId, record] of this.records) {
      if (record.namespace === namespace && (record.owner === subject || record.allowedSubjects.includes(subject)) && record.expiresAt && Date.parse(record.expiresAt) <= now) {
        this.records.delete(recordId);
        removed += 1;
      }
    }
    if (removed) await this.rewrite();
    return removed;
  }

  async list(namespace: string, subject: string): Promise<MemoryRecord[]> {
    return (await this.search({ query: '', namespace, subject, limit: Number.MAX_SAFE_INTEGER })).map((hit) => hit.record);
  }

  private terms(query: string): string[] {
    return [...new Set(query.toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length >= 2))];
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
