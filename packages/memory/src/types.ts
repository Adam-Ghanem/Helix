import type { AgentId, Id, TaskId } from '../../core/src/index.js';

export type MemoryNamespace = 'global' | `agent:${string}` | `swarm:${string}` | `task:${string}` | `session:${string}`;
export type MemoryType = 'fact' | 'task' | 'solution' | 'pattern' | 'failure' | 'decision' | 'observation' | 'agent-experience' | 'workflow' | 'routing-hint';

export interface MemoryProvenance {
  sourceType: 'task-outcome' | 'agent-observation' | 'workflow' | 'user' | 'import' | 'system';
  sourceId: string;
  timestamp: string;
  confidence: number;
  agentId?: AgentId;
  swarmId?: string;
  taskId?: TaskId;
  executionId?: string;
  sourceNodeId?: string;
}

export interface MemoryAccessPolicy {
  visibility: 'private' | 'shared' | 'public';
  allowedSubjects: string[];
  allowedSwarmIds: string[];
  owner: string;
}

export interface MemoryEntry {
  id: Id;
  namespace: MemoryNamespace;
  type: MemoryType;
  content: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
  source: string;
  agentId?: AgentId;
  swarmId?: string;
  taskId?: TaskId;
  sessionId?: string;
  confidence: number;
  tags: string[];
  provenance: MemoryProvenance;
  accessPolicy: MemoryAccessPolicy;
  embedding?: number[];
}

export interface MemoryBatchInput {
  input: MemoryEntryInput;
  context?: MemoryAccessContext;
}

export interface MemoryCompactionOptions {
  mergePatterns?: boolean;
  removeExpiredLegacy?: boolean;
  vacuum?: boolean;
}

export interface MemoryCompactionResult {
  removedDuplicates: number;
  removedExpiredLegacy: number;
  vacuumed: boolean;
}

export interface MemoryBackend {
  init(): Promise<void>;
  create(input: MemoryEntryInput, context?: MemoryAccessContext): Promise<MemoryEntry>;
  createMany?(inputs: MemoryBatchInput[]): Promise<MemoryEntry[]>;
  get(memoryId: string, context?: MemoryAccessContext): Promise<MemoryEntry>;
  update(memoryId: string, input: MemoryUpdateInput, context: MemoryAccessContext): Promise<MemoryEntry>;
  delete(memoryId: string, context: MemoryAccessContext): Promise<void>;
  listEntries(context: MemoryAccessContext, namespace?: MemoryNamespace): Promise<MemoryEntry[]>;
  count(context?: MemoryAccessContext): Promise<number>;
  stats(context?: MemoryAccessContext): Promise<MemoryStats>;
  searchEntries(options: MemorySearchOptions): Promise<MemorySearchResult[]>;
  store(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  compact?(options?: MemoryCompactionOptions): Promise<MemoryCompactionResult>;
  cacheSize?(): number;
}

export interface MemoryEntryInput {
  namespace: MemoryNamespace;
  type: MemoryType;
  content: string;
  metadata?: Record<string, string | number | boolean | null>;
  source: string;
  agentId?: AgentId;
  swarmId?: string;
  taskId?: TaskId;
  sessionId?: string;
  confidence?: number;
  tags?: string[];
  provenance: MemoryProvenance;
  accessPolicy: MemoryAccessPolicy;
}

export interface MemoryUpdateInput {
  content?: string;
  metadata?: Record<string, string | number | boolean | null>;
  confidence?: number;
  tags?: string[];
  accessPolicy?: MemoryAccessPolicy;
}

export interface MemoryAccessContext {
  subject: string;
  roles?: string[];
  agentId?: AgentId;
  swarmIds?: string[];
  taskIds?: TaskId[];
  canReadPrivate?: boolean;
  canDelete?: boolean;
}

export interface MemorySearchWeights {
  keyword: number;
  semantic: number;
  recency: number;
  namespace: number;
  confidence: number;
  provenance: number;
}

export interface MemorySearchOptions {
  query: string;
  namespace?: MemoryNamespace;
  namespaces?: MemoryNamespace[];
  tags?: string[];
  types?: MemoryType[];
  metadata?: Record<string, string | number | boolean | null>;
  halfLifeDays?: number;
  agentId?: AgentId;
  swarmId?: string;
  limit?: number;
  retrievalLimit?: number;
  minScore?: number;
  minConfidence?: number;
  context?: MemoryAccessContext;
  weights?: Partial<MemorySearchWeights>;
  now?: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedBy: string[];
  explanation: string;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface MemoryStoreBackend {
  init(): Promise<void>;
  append(record: string): Promise<void>;
  rewrite(records: string[]): Promise<void>;
}

export interface MemoryStats {
  count: number;
  byNamespace: Record<string, number>;
  byType: Record<string, number>;
}

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

export interface RoutingLearningSignal {
  agentId: AgentId;
  taskType: string;
  capabilityOverlap: number;
  successRate: number;
  successes: number;
  failures: number;
  repeatedFailures: number;
  confidence: number;
  decayedScore: number;
  lastUpdated: string;
}

export interface RoutingHints {
  preferredAgents: AgentId[];
  preferredCapabilities: string[];
  avoidAgents: AgentId[];
  confidence: number;
  reasons: string[];
}

export interface AgentExperience {
  agentId: AgentId;
  successfulTaskCount: number;
  failedTaskCount: number;
  successRate: number;
  averageExecutionTimeMs: number;
  capabilityTaskAssociations: Record<string, number>;
  preferredTaskClasses: Record<string, number>;
  recentFailures: Array<{ taskType: string; timestamp: string; errorCategory: string }>;
  learnedPatterns: string[];
}

export interface TaskOutcomeLearningInput {
  executionId: string;
  taskId: TaskId;
  taskType: string;
  agentId: AgentId;
  capabilities: string[];
  success: boolean;
  quality: number;
  executionTimeMs: number;
  attempts: number;
  output?: unknown;
  error?: string;
  swarmId?: string;
  sessionId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
