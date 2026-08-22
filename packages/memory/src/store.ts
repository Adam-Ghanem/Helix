import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { id, timestamp } from '../../core/src/index.js';
import { assertMemoryWritePolicy, canDeleteMemory, canReadMemory } from './acl.js';
import { parseNamespace } from './namespace.js';
import { DeterministicEmbeddingProvider, scoreMemory } from './search.js';
import type { EmbeddingProvider } from './types.js';
import type { MemoryAccessContext, MemoryEntry, MemoryEntryInput, MemoryHit, MemoryQuery, MemoryRecord, MemorySearchOptions, MemorySearchResult, MemoryStats, MemoryUpdateInput } from './types.js';

interface UpsertLine { kind: 'upsert'; entry: MemoryEntry }
interface DeleteLine { kind: 'delete'; id: string }

type PersistedLine = UpsertLine | DeleteLine | MemoryRecord;

export class MemoryStore {
  private readonly file: string;
  private readonly records = new Map<string, MemoryRecord>();
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly embeddingProvider: EmbeddingProvider;
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly directory: string;

  constructor(directory: string, options?: { embeddingProvider?: EmbeddingProvider }) {
    this.file = join(directory, 'memory.records.jsonl');
    this.directory = directory;
    this.embeddingProvider = options?.embeddingProvider ?? new DeterministicEmbeddingProvider();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true });
    try {
      const contents = await readFile(this.file, 'utf8');
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as PersistedLine;
        if ('kind' in parsed && parsed.kind === 'upsert') this.entries.set(parsed.entry.id, parsed.entry);
        else if ('kind' in parsed && parsed.kind === 'delete') this.entries.delete(parsed.id);
        else if ('id' in parsed && 'owner' in parsed) this.records.set(parsed.id, parsed);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async create(input: MemoryEntryInput, context?: MemoryAccessContext): Promise<MemoryEntry> {
    const [entry] = await this.createMany([{ input, ...(context ? { context } : {}) }]);
    if (!entry) throw new Error('Memory create did not produce an entry');
    return entry;
  }

  async createMany(inputs: Array<{ input: MemoryEntryInput; context?: MemoryAccessContext }>): Promise<MemoryEntry[]> {
    await this.init();
    const entries = await Promise.all(inputs.map(async ({ input, context }) => {
      const subject = context?.subject ?? input.accessPolicy.owner;
      assertMemoryWritePolicy({ namespace: input.namespace, accessPolicy: input.accessPolicy, subject });
      const now = timestamp();
      return {
        ...input,
        id: id('mem'),
        metadata: { ...(input.metadata ?? {}) },
        tags: [...new Set(input.tags ?? [])],
        confidence: clamp(input.confidence ?? input.provenance.confidence),
        createdAt: now,
        updatedAt: now,
        embedding: await this.embeddingProvider.embed(input.content),
      } satisfies MemoryEntry;
    }));
    await this.enqueue(async () => {
      for (const entry of entries) this.entries.set(entry.id, entry);
      if (entries.length) await appendFile(this.file, `${entries.map((entry) => JSON.stringify({ kind: 'upsert', entry })).join('\n')}\n`, 'utf8');
    });
    return entries.map((entry) => structuredClone(entry));
  }

  async get(memoryId: string, context?: MemoryAccessContext): Promise<MemoryEntry> {
    await this.init();
    const entry = this.entries.get(memoryId);
    if (!entry) throw new Error(`Unknown memory: ${memoryId}`);
    if (context && !canReadMemory(entry, context)) throw new Error('Memory read is not authorized');
    return structuredClone(entry);
  }

  async update(memoryId: string, input: MemoryUpdateInput, context: MemoryAccessContext): Promise<MemoryEntry> {
    await this.init();
    const existing = this.entries.get(memoryId);
    if (!existing) throw new Error(`Unknown memory: ${memoryId}`);
    if (!canReadMemory(existing, context) || existing.accessPolicy.owner !== context.subject) throw new Error('Memory update is not authorized');
    const updated: MemoryEntry = {
      ...existing,
      ...(input.content !== undefined ? { content: input.content, embedding: await this.embeddingProvider.embed(input.content) } : {}),
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      ...(input.confidence !== undefined ? { confidence: clamp(input.confidence) } : {}),
      ...(input.tags ? { tags: [...new Set(input.tags)] } : {}),
      ...(input.accessPolicy ? { accessPolicy: input.accessPolicy } : {}),
      updatedAt: timestamp(),
    };
    await this.enqueue(async () => {
      this.entries.set(memoryId, updated);
      await appendFile(this.file, `${JSON.stringify({ kind: 'upsert', entry: updated })}\n`, 'utf8');
    });
    return structuredClone(updated);
  }

  async delete(memoryId: string, context: MemoryAccessContext): Promise<void> {
    await this.init();
    const entry = this.entries.get(memoryId);
    if (!entry) throw new Error(`Unknown memory: ${memoryId}`);
    if (!canDeleteMemory(entry, context)) throw new Error('Memory deletion is not authorized');
    await this.enqueue(async () => {
      this.entries.delete(memoryId);
      await appendFile(this.file, `${JSON.stringify({ kind: 'delete', id: memoryId })}\n`, 'utf8');
    });
  }

  async listEntries(context: MemoryAccessContext, namespace?: MemoryEntry['namespace']): Promise<MemoryEntry[]> {
    await this.init();
    return [...this.entries.values()].filter((entry) => (!namespace || entry.namespace === namespace) && canReadMemory(entry, context)).map((entry) => structuredClone(entry));
  }

  async count(context?: MemoryAccessContext): Promise<number> {
    await this.init();
    return [...this.entries.values()].filter((entry) => !context || canReadMemory(entry, context)).length;
  }

  async stats(context?: MemoryAccessContext): Promise<MemoryStats> {
    const visible = context ? await this.listEntries(context) : [...this.entries.values()];
    const byNamespace: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const entry of visible) {
      byNamespace[entry.namespace] = (byNamespace[entry.namespace] ?? 0) + 1;
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
    }
    return { count: visible.length, byNamespace, byType };
  }

  async searchEntries(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    await this.init();
    const context = options.context ?? { subject: 'anonymous' };
    const allowedNamespaces = options.namespaces ?? (options.namespace ? [options.namespace] : undefined);
    const now = options.now ? Date.parse(options.now) : Date.now();
    const results: MemorySearchResult[] = [];
    for (const entry of this.entries.values()) {
      if (allowedNamespaces && !allowedNamespaces.includes(entry.namespace)) continue;
      if (options.tags && !options.tags.every((tag) => entry.tags.includes(tag))) continue;
      if (options.types && !options.types.includes(entry.type)) continue;
      if (options.metadata && !Object.entries(options.metadata).every(([key, value]) => entry.metadata[key] === value)) continue;
      if (options.agentId && entry.agentId !== options.agentId) continue;
      if (options.swarmId && entry.swarmId !== options.swarmId) continue;
      if (!canReadMemory(entry, context)) continue;
      const result = await scoreMemory(entry, options, this.embeddingProvider, now);
      if (result.score >= (options.minScore ?? 0)) results.push(result);
    }
    results.sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt) || left.entry.id.localeCompare(right.entry.id));
    return results.slice(0, Math.max(0, options.limit ?? 20));
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
    const terms = [...new Set(query.query.toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length >= 2))];
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

  private async rewrite(): Promise<void> {
    await this.enqueue(async () => {
      const lines = [...this.records.values()].map((record) => JSON.stringify(record)).concat([...this.entries.values()].map((entry) => JSON.stringify({ kind: 'upsert', entry })));
      await writeFile(this.file, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
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

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
