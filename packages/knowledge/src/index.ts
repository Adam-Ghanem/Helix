import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Id, id, timestamp } from '../../core/src/index.js';

export interface KnowledgeEntity {
  id: Id;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  confidence: number;
  version: number;
  provenance: { executionId?: string; agentId?: string; tool?: string; source?: string };
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRelation {
  id: Id;
  from: Id;
  to: Id;
  type: string;
  confidence: number;
  provenance: KnowledgeEntity['provenance'];
  createdAt: string;
}

export class KnowledgeGraph {
  private readonly entities = new Map<Id, KnowledgeEntity>();
  private readonly relations = new Map<Id, KnowledgeRelation>();
  private initialized = false;
  private readonly file: string;

  constructor(directory: string) {
    this.file = join(directory, 'knowledge.graph.jsonl');
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
        const record = JSON.parse(line) as { kind: 'entity' | 'relation'; value: KnowledgeEntity | KnowledgeRelation };
        if (record.kind === 'entity') this.entities.set(record.value.id, record.value as KnowledgeEntity);
        else this.relations.set(record.value.id, record.value as KnowledgeRelation);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async upsertEntity(input: Omit<KnowledgeEntity, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: Id }): Promise<KnowledgeEntity> {
    await this.init();
    const existing = input.id ? this.entities.get(input.id) : undefined;
    const now = timestamp();
    const entity: KnowledgeEntity = {
      ...input,
      id: input.id ?? id('entity'),
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.entities.set(entity.id, entity);
    await appendFile(this.file, `${JSON.stringify({ kind: 'entity', value: entity })}\n`, 'utf8');
    return structuredClone(entity);
  }

  async relate(input: Omit<KnowledgeRelation, 'id' | 'createdAt'>): Promise<KnowledgeRelation> {
    await this.init();
    if (!this.entities.has(input.from) || !this.entities.has(input.to)) throw new Error('Knowledge relation endpoints must exist');
    const relation: KnowledgeRelation = { ...input, id: id('rel'), createdAt: timestamp() };
    this.relations.set(relation.id, relation);
    await appendFile(this.file, `${JSON.stringify({ kind: 'relation', value: relation })}\n`, 'utf8');
    return structuredClone(relation);
  }

  async neighborhood(entityId: Id): Promise<{ entity?: KnowledgeEntity; relations: KnowledgeRelation[]; entities: KnowledgeEntity[] }> {
    await this.init();
    const relations = [...this.relations.values()].filter((relation) => relation.from === entityId || relation.to === entityId);
    const ids = new Set(relations.flatMap((relation) => [relation.from, relation.to]));
    ids.delete(entityId);
    const entity = this.entities.get(entityId);
    return { ...(entity ? { entity: structuredClone(entity) } : {}), relations: structuredClone(relations), entities: [...ids].map((neighbor) => this.entities.get(neighbor)).filter((item): item is KnowledgeEntity => Boolean(item)).map((item) => structuredClone(item)) };
  }

  async listEntities(type?: string): Promise<KnowledgeEntity[]> {
    await this.init();
    return [...this.entities.values()].filter((entity) => !type || entity.type === type).map((entity) => structuredClone(entity));
  }
}
