import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id, timestamp } from '../../core/src/index.js';
import { assertMemoryWritePolicy, canDeleteMemory, canReadMemory } from './acl.js';
import { MemoryCache } from './cache.js';
import { parseNamespace } from './namespace.js';
import { DeterministicEmbeddingProvider, scoreMemory } from './search.js';
import type { EmbeddingProvider } from './types.js';
import type { MemoryAccessContext, MemoryBackend, MemoryBatchInput, MemoryCompactionOptions, MemoryCompactionResult, MemoryEntry, MemoryEntryInput, MemoryHit, MemoryQuery, MemoryRecord, MemorySearchOptions, MemorySearchResult, MemoryStats, MemoryUpdateInput } from './types.js';

interface EntryRow { id: string; namespace: string; type: string; agent_id: string | null; swarm_id: string | null; task_id: string | null; updated_at: string; confidence: number; entry_json: string }
interface LegacyRow { record_json: string }
interface FtsRow { memory_id: string }

export interface SqliteMemoryStoreOptions {
  cache?: { maxEntries?: number; ttlMs?: number };
  busyTimeoutMs?: number;
  retrievalLimit?: number;
  embeddingProvider?: EmbeddingProvider;
  migrateJsonlFile?: string;
}

export class SqliteMemoryStore implements MemoryBackend {
  private readonly db: Database;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly cache: MemoryCache<unknown>;
  private readonly retrievalLimit: number;
  private readonly migrateJsonlFile: string | undefined;
  private initialized = false;

  constructor(file: string, options: SqliteMemoryStoreOptions = {}) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { timeout: options.busyTimeoutMs ?? 5_000 });
    this.embeddingProvider = options.embeddingProvider ?? new DeterministicEmbeddingProvider();
    this.cache = new MemoryCache(options.cache);
    this.retrievalLimit = Math.max(10, options.retrievalLimit ?? 2_000);
    this.migrateJsonlFile = options.migrateJsonlFile;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        swarm_id TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confidence REAL NOT NULL,
        entry_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_memory_records (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at TEXT,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
      CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent_id);
      CREATE INDEX IF NOT EXISTS idx_memory_task ON memory_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_memory_swarm ON memory_entries(swarm_id);
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
      CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_entries(updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_confidence ON memory_entries(confidence);
      CREATE TABLE IF NOT EXISTS memory_tags (memory_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (memory_id, tag), FOREIGN KEY (memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, content, tags, metadata);
      CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_legacy_namespace_owner ON legacy_memory_records(namespace, owner);
      CREATE INDEX IF NOT EXISTS idx_legacy_expiry ON legacy_memory_records(expires_at);
    `);
    this.backfillTags();
    if (this.migrateJsonlFile) await this.migrateJsonl(this.migrateJsonlFile);
    this.initialized = true;
  }

  async create(input: MemoryEntryInput, context?: MemoryAccessContext): Promise<MemoryEntry> {
    const [entry] = await this.createMany([{ input, ...(context ? { context } : {}) }]);
    if (!entry) throw new Error('Memory create did not produce an entry');
    return entry;
  }

  async createMany(inputs: MemoryBatchInput[]): Promise<MemoryEntry[]> {
    await this.init();
    const entries = await Promise.all(inputs.map(async ({ input, context }) => this.prepareEntry(input, context)));
    const insert = this.db.prepare('INSERT INTO memory_entries (id, namespace, type, agent_id, swarm_id, task_id, created_at, updated_at, confidence, entry_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const transaction = this.db.transaction((values: MemoryEntry[]) => {
      for (const entry of values) {
        insert.run(entry.id, entry.namespace, entry.type, entry.agentId ?? null, entry.swarmId ?? null, entry.taskId ?? null, entry.createdAt, entry.updatedAt, entry.confidence, JSON.stringify(entry));
        const tagInsert = this.db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
        for (const tag of entry.tags) tagInsert.run(entry.id, tag);
        this.db.prepare('INSERT INTO memory_fts (memory_id, content, tags, metadata) VALUES (?, ?, ?, ?)').run(entry.id, entry.content, entry.tags.join(' '), JSON.stringify(entry.metadata));
      }
    });
    transaction(entries);
    this.cache.clear();
    return entries.map((entry) => structuredClone(entry));
  }

  async get(memoryId: string, context?: MemoryAccessContext): Promise<MemoryEntry> {
    await this.init();
    const key = `entry:${memoryId}`;
    const cached = this.cache.get(key) as MemoryEntry | undefined;
    const entry = cached ?? this.readEntry(memoryId);
    if (!entry) throw new Error(`Unknown memory: ${memoryId}`);
    if (context && !canReadMemory(entry, context)) throw new Error('Memory read is not authorized');
    if (!cached) this.cache.set(key, entry);
    return structuredClone(entry);
  }

  async update(memoryId: string, input: MemoryUpdateInput, context: MemoryAccessContext): Promise<MemoryEntry> {
    const existing = await this.get(memoryId, context);
    if (existing.accessPolicy.owner !== context.subject) throw new Error('Memory update is not authorized');
    const updated: MemoryEntry = {
      ...existing,
      ...(input.content !== undefined ? { content: input.content, embedding: await this.embeddingProvider.embed(input.content) } : {}),
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      ...(input.confidence !== undefined ? { confidence: clamp(input.confidence) } : {}),
      ...(input.tags ? { tags: [...new Set(input.tags)] } : {}),
      ...(input.accessPolicy ? { accessPolicy: input.accessPolicy } : {}),
      updatedAt: timestamp(),
    };
    await this.init();
    const transaction = this.db.transaction(() => {
      this.db.prepare('UPDATE memory_entries SET namespace = ?, type = ?, agent_id = ?, swarm_id = ?, task_id = ?, updated_at = ?, confidence = ?, entry_json = ? WHERE id = ?').run(updated.namespace, updated.type, updated.agentId ?? null, updated.swarmId ?? null, updated.taskId ?? null, updated.updatedAt, updated.confidence, JSON.stringify(updated), memoryId);
      this.db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(memoryId);
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
      const tagInsert = this.db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of updated.tags) tagInsert.run(memoryId, tag);
      this.db.prepare('INSERT INTO memory_fts (memory_id, content, tags, metadata) VALUES (?, ?, ?, ?)').run(memoryId, updated.content, updated.tags.join(' '), JSON.stringify(updated.metadata));
    });
    transaction();
    this.cache.invalidatePrefix('entry:');
    this.cache.invalidatePrefix('search:');
    return structuredClone(updated);
  }

  async delete(memoryId: string, context: MemoryAccessContext): Promise<void> {
    const entry = await this.get(memoryId, context);
    if (!canDeleteMemory(entry, context)) throw new Error('Memory deletion is not authorized');
    await this.init();
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(memoryId);
      this.db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(memoryId);
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
    });
    transaction();
    this.cache.clear();
  }

  async listEntries(context: MemoryAccessContext, namespace?: MemoryEntry['namespace']): Promise<MemoryEntry[]> {
    await this.init();
    const key = `list:${contextKey(context)}:${namespace ?? '*'}`;
    const cached = this.cache.get(key) as MemoryEntry[] | undefined;
    if (cached) return cached;
    const rows = namespace ? this.db.prepare<EntryRow>('SELECT * FROM memory_entries WHERE namespace = ? ORDER BY updated_at DESC').all(namespace) : this.db.prepare<EntryRow>('SELECT * FROM memory_entries ORDER BY updated_at DESC').all();
    const entries = rows.map((row) => parseEntry(row.entry_json)).filter((entry) => canReadMemory(entry, context));
    this.cache.set(key, entries);
    return structuredClone(entries);
  }

  async count(context?: MemoryAccessContext): Promise<number> {
    await this.init();
    if (!context) return Number((this.db.prepare<{ count: number }>('SELECT count(*) AS count FROM memory_entries').get()?.count ?? 0));
    return (await this.listEntries(context)).length;
  }

  async stats(context?: MemoryAccessContext): Promise<MemoryStats> {
    const visible = context ? await this.listEntries(context) : await this.allEntries();
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
    const key = `search:${JSON.stringify(options)}`;
    const cached = this.cache.get(key) as MemorySearchResult[] | undefined;
    if (cached) return cached;
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const tokens = options.query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2).slice(0, 32);
    if (tokens.length) {
      const ftsQuery = tokens.map((token) => `${token}*`).join(' OR ');
      const ftsRows = this.db.prepare<FtsRow>('SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?').all(ftsQuery, this.retrievalLimit);
      if (!ftsRows.length) return [];
      clauses.push(`id IN (${ftsRows.map(() => '?').join(',')})`);
      parameters.push(...ftsRows.map((row) => row.memory_id));
    }
    const namespaces = options.namespaces ?? (options.namespace ? [options.namespace] : undefined);
    if (namespaces?.length) { clauses.push(`namespace IN (${namespaces.map(() => '?').join(',')})`); parameters.push(...namespaces); }
    if (options.agentId) { clauses.push('agent_id = ?'); parameters.push(options.agentId); }
    if (options.swarmId) { clauses.push('swarm_id = ?'); parameters.push(options.swarmId); }
    if (options.types?.length) { clauses.push(`type IN (${options.types.map(() => '?').join(',')})`); parameters.push(...options.types); }
    if (options.minConfidence !== undefined) { clauses.push('confidence >= ?'); parameters.push(options.minConfidence); }
    if (options.tags?.length) { clauses.push(`id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${options.tags.map(() => '?').join(',')}) GROUP BY memory_id HAVING count(DISTINCT tag) = ?)`); parameters.push(...options.tags, options.tags.length); }
    const sql = `SELECT * FROM memory_entries${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
    parameters.push(Math.max(10, Math.min(this.retrievalLimit, options.retrievalLimit ?? this.retrievalLimit)));
    const rows = this.db.prepare<EntryRow>(sql).all(...parameters);
    const context = options.context ?? { subject: 'anonymous' };
    const now = options.now ? Date.parse(options.now) : Date.now();
    const results: MemorySearchResult[] = [];
    for (const row of rows) {
      const entry = parseEntry(row.entry_json);
      if (!canReadMemory(entry, context)) continue;
      if (options.tags && !options.tags.every((tag) => entry.tags.includes(tag))) continue;
      if (options.metadata && !Object.entries(options.metadata).every(([name, value]) => entry.metadata[name] === value)) continue;
      const result = await scoreMemory(entry, options, this.embeddingProvider, now);
      if (result.score >= (options.minScore ?? 0)) results.push(result);
    }
    results.sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt) || left.entry.id.localeCompare(right.entry.id));
    const bounded = results.slice(0, Math.max(0, options.limit ?? 20));
    this.cache.set(key, bounded);
    return structuredClone(bounded);
  }

  async store(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    await this.init();
    const now = timestamp();
    const record: MemoryRecord = { ...input, id: id('mem'), createdAt: now, updatedAt: now, allowedSubjects: [...new Set(input.allowedSubjects)] };
    this.db.prepare('INSERT INTO legacy_memory_records (id, namespace, owner, expires_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)').run(record.id, record.namespace, record.owner, record.expiresAt ?? null, record.updatedAt, JSON.stringify(record));
    return structuredClone(record);
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    await this.init();
    const rows = this.db.prepare<LegacyRow>('SELECT record_json FROM legacy_memory_records WHERE namespace = ? AND (owner = ? OR record_json LIKE ?) ORDER BY updated_at DESC LIMIT ?').all(query.namespace, query.subject, '%"allowedSubjects":["*"%', query.limit ?? 20);
    const terms = [...new Set(query.query.toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length >= 2))];
    const hits: MemoryHit[] = [];
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as MemoryRecord;
      if (record.owner !== query.subject && !record.allowedSubjects.includes('*') && !record.allowedSubjects.includes(query.subject)) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) continue;
      const haystack = `${record.content} ${record.source.uri ?? ''}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      if (!matchedTerms.length && terms.length) continue;
      const lexical = terms.length ? matchedTerms.length / terms.length : 0;
      hits.push({ record: structuredClone(record), score: 0.65 * lexical + 0.20 * record.importance + 0.15 * record.confidence, matchedTerms });
    }
    hits.sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt));
    return hits.slice(0, query.limit ?? 20);
  }

  private backfillTags(): void {
    const rows = this.db.prepare<EntryRow>('SELECT * FROM memory_entries').all();
    const insert = this.db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
    const ftsInsert = this.db.prepare('INSERT OR REPLACE INTO memory_fts (memory_id, content, tags, metadata) VALUES (?, ?, ?, ?)');
    const transaction = this.db.transaction((values: EntryRow[]) => { for (const row of values) { const entry = parseEntry(row.entry_json); for (const tag of entry.tags) insert.run(entry.id, tag); ftsInsert.run(entry.id, entry.content, entry.tags.join(' '), JSON.stringify(entry.metadata)); } });
    transaction(rows);
  }

  private async migrateJsonl(file: string): Promise<void> {
    let contents: string;
    try { contents = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const lines = contents.split('\\n').filter((line) => line.trim());
    const insertEntry = this.db.prepare('INSERT OR IGNORE INTO memory_entries (id, namespace, type, agent_id, swarm_id, task_id, created_at, updated_at, confidence, entry_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertTag = this.db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
    const insertLegacy = this.db.prepare('INSERT OR IGNORE INTO legacy_memory_records (id, namespace, owner, expires_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)');
    const transaction = this.db.transaction((rawLines: string[]) => {
      for (const line of rawLines) {
        const parsed = JSON.parse(line) as { kind?: string; entry?: MemoryEntry; id?: string } & Partial<MemoryRecord>;
        if (parsed.kind === 'delete') { if (parsed.id) this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(parsed.id); continue; }
        if (parsed.kind === 'upsert' && parsed.entry) {
          const entry = parseEntry(JSON.stringify(parsed.entry));
          insertEntry.run(entry.id, entry.namespace, entry.type, entry.agentId ?? null, entry.swarmId ?? null, entry.taskId ?? null, entry.createdAt, entry.updatedAt, entry.confidence, JSON.stringify(entry));
          for (const tag of entry.tags) insertTag.run(entry.id, tag);
          this.db.prepare('INSERT OR REPLACE INTO memory_fts (memory_id, content, tags, metadata) VALUES (?, ?, ?, ?)').run(entry.id, entry.content, entry.tags.join(' '), JSON.stringify(entry.metadata));
          continue;
        }
        if (typeof parsed.id === 'string' && typeof parsed.namespace === 'string' && typeof parsed.owner === 'string') {
          const record = parsed as unknown as MemoryRecord;
          insertLegacy.run(record.id, record.namespace, record.owner, record.expiresAt ?? null, record.updatedAt, JSON.stringify(record));
        }
      }
    });
    transaction(lines);
  }

  async compact(options: MemoryCompactionOptions = {}): Promise<MemoryCompactionResult> {
    await this.init();
    let removedDuplicates = 0;
    let removedExpiredLegacy = 0;
    const transaction = this.db.transaction(() => {
      if (options.mergePatterns ?? true) {
        const rows = this.db.prepare<EntryRow>("SELECT * FROM memory_entries WHERE type IN ('solution', 'pattern', 'routing-hint') ORDER BY updated_at DESC").all();
        const seen = new Map<string, string>();
        const remove = this.db.prepare('DELETE FROM memory_entries WHERE id = ?');
        const update = this.db.prepare('UPDATE memory_entries SET entry_json = ? WHERE id = ?');
        for (const row of rows) {
          const entry = parseEntry(row.entry_json);
          const duplicateKey = `${entry.namespace}|${entry.type}|${entry.content.trim().toLowerCase()}`;
          const winnerId = seen.get(duplicateKey);
          if (!winnerId) { seen.set(duplicateKey, entry.id); continue; }
          const winner = parseEntry(this.db.prepare<EntryRow>('SELECT * FROM memory_entries WHERE id = ?').get(winnerId)!.entry_json);
          const merged: MemoryEntry = { ...winner, metadata: { ...winner.metadata, mergedSamples: Number(winner.metadata.mergedSamples ?? 1) + Number(entry.metadata.mergedSamples ?? 1) }, tags: [...new Set([...winner.tags, ...entry.tags])], updatedAt: winner.updatedAt > entry.updatedAt ? winner.updatedAt : entry.updatedAt };
          update.run(JSON.stringify(merged), winner.id);
          remove.run(entry.id);
          removedDuplicates += 1;
        }
      }
      if (options.removeExpiredLegacy) {
        const result = this.db.prepare('DELETE FROM legacy_memory_records WHERE expires_at IS NOT NULL AND expires_at <= ?').run(timestamp());
        removedExpiredLegacy = result.changes;
      }
    });
    transaction();
    const vacuumed = Boolean(options.vacuum);
    if (vacuumed) this.db.exec('VACUUM');
    this.cache.clear();
    return { removedDuplicates, removedExpiredLegacy, vacuumed };
  }

  cacheSize(): number { return this.cache.size; }

  close(): void { if (this.initialized) this.db.close(); }

  private async allEntries(): Promise<MemoryEntry[]> {
    const rows = this.db.prepare<EntryRow>('SELECT * FROM memory_entries ORDER BY updated_at DESC').all();
    return rows.map((row) => parseEntry(row.entry_json));
  }

  private readEntry(memoryId: string): MemoryEntry | undefined {
    const row = this.db.prepare<EntryRow>('SELECT * FROM memory_entries WHERE id = ?').get(memoryId);
    return row ? parseEntry(row.entry_json) : undefined;
  }

  private async prepareEntry(input: MemoryEntryInput, context?: MemoryAccessContext): Promise<MemoryEntry> {
    const subject = context?.subject ?? input.accessPolicy.owner;
    assertMemoryWritePolicy({ namespace: input.namespace, accessPolicy: input.accessPolicy, subject });
    validateProvenance(input);
    const now = timestamp();
    return { ...input, id: id('mem'), metadata: { ...(input.metadata ?? {}) }, tags: [...new Set(input.tags ?? [])], confidence: clamp(input.confidence ?? input.provenance.confidence), createdAt: now, updatedAt: now, embedding: await this.embeddingProvider.embed(input.content) };
  }
}

function parseEntry(value: string): MemoryEntry {
  const entry = JSON.parse(value) as MemoryEntry;
  parseNamespace(entry.namespace);
  validateProvenance(entry);
  if (!entry.id || !entry.content || !entry.accessPolicy) throw new Error('Corrupt SQLite memory entry');
  return entry;
}

function validateProvenance(input: Pick<MemoryEntry, 'provenance'> | MemoryEntryInput): void {
  if (!input.provenance.sourceId || !input.provenance.sourceType || !input.provenance.timestamp || !Number.isFinite(input.provenance.confidence)) throw new Error('Memory provenance is invalid');
}

function contextKey(context: MemoryAccessContext): string { return JSON.stringify({ subject: context.subject, agentId: context.agentId, swarmIds: context.swarmIds, taskIds: context.taskIds, canReadPrivate: context.canReadPrivate, canDelete: context.canDelete }); }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
