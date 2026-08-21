import { timestamp } from '../../core/src/index.js';
import { MemoryStore, type AgentExperience, type MemoryAccessContext, type MemoryEntry, type MemorySearchOptions, type MemorySearchResult, type RoutingHints, type RoutingLearningSignal, type TaskOutcomeLearningInput } from '../../memory/src/index.js';
import { safeErrorCategory, sanitizeExecutionResult, taskOutcomeProvenance } from '../../memory/src/provenance.js';
import type { RoutingCandidate, RoutingRequest } from '../../router/src/index.js';

export interface PersistentLearningOptions {
  halfLifeDays?: number;
  failureThreshold?: number;
  failureConfidenceThreshold?: number;
  maxLearningBonus?: number;
}

export interface ExecutionHint {
  hint: string;
  confidence: number;
  sourceMemoryIds: string[];
}

export class PersistentLearningEngine {
  private readonly halfLifeDays: number;
  private readonly failureThreshold: number;
  private readonly failureConfidenceThreshold: number;
  readonly maxLearningBonus: number;

  constructor(private readonly memory: MemoryStore, options: PersistentLearningOptions = {}) {
    this.halfLifeDays = options.halfLifeDays ?? 30;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.failureConfidenceThreshold = options.failureConfidenceThreshold ?? 0.7;
    this.maxLearningBonus = Math.min(0.1, Math.max(0, options.maxLearningBonus ?? 0.1));
  }

  async recordSuccess(input: TaskOutcomeLearningInput): Promise<MemoryEntry[]> {
    return this.recordOutcome(input, true);
  }

  async recordFailure(input: TaskOutcomeLearningInput): Promise<MemoryEntry[]> {
    return this.recordOutcome(input, false);
  }

  async recall(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return this.memory.searchEntries(options);
  }

  async suggestRouting(request: RoutingRequest, context: MemoryAccessContext = { subject: 'system' }): Promise<RoutingHints> {
    const entries = await this.memory.listEntries(context);
    const candidates = entries.filter((entry) => (entry.type === 'routing-hint' || entry.type === 'failure') && entry.namespace === 'global' && entry.metadata.taskType === request.taskType);
    const signals = this.aggregateSignals(candidates, request);
    const preferredAgents = signals.filter((signal) => signal.decayedScore > 0).sort((left, right) => right.decayedScore - left.decayedScore || left.agentId.localeCompare(right.agentId)).slice(0, 5).map((signal) => signal.agentId);
    const avoidAgents = signals.filter((signal) => signal.repeatedFailures >= this.failureThreshold && signal.confidence >= this.failureConfidenceThreshold).sort((left, right) => right.repeatedFailures - left.repeatedFailures || left.agentId.localeCompare(right.agentId)).slice(0, 5).map((signal) => signal.agentId);
    const preferredCapabilities = [...new Set(candidates.filter((entry) => Number(entry.metadata.success) === 1).flatMap((entry) => entry.tags.filter((tag) => tag.startsWith('capability:')).map((tag) => tag.slice(11))))].slice(0, 10);
    const confidence = signals.length ? Math.min(1, signals.reduce((sum, signal) => sum + signal.confidence, 0) / signals.length) : 0;
    const reasons = signals.slice().sort((left, right) => right.decayedScore - left.decayedScore).slice(0, 5).map((signal) => `${signal.agentId}: ${signal.successes} successes, ${signal.failures} failures, decayed signal ${signal.decayedScore.toFixed(3)}`);
    return { preferredAgents, preferredCapabilities, avoidAgents, confidence, reasons };
  }

  async suggestExecutionHints(request: RoutingRequest, context: MemoryAccessContext = { subject: 'system' }): Promise<ExecutionHint[]> {
    const results = await this.recall({ query: `${request.taskType} ${request.requiredCapabilities.join(' ')}`, namespace: 'global', types: ['solution', 'pattern', 'failure', 'routing-hint'], limit: 8, context });
    return results.map((result) => ({ hint: result.explanation, confidence: result.entry.confidence, sourceMemoryIds: [result.entry.id] }));
  }

  async routingScores(request: RoutingRequest, candidates: RoutingCandidate[], context: MemoryAccessContext = { subject: 'system' }): Promise<Map<string, number>> {
    const hints = await this.suggestRouting(request, context);
    const preferred = new Set(hints.preferredAgents);
    const avoided = new Set(hints.avoidAgents);
    const scores = new Map<string, number>();
    for (const candidate of candidates) {
      let score = 0;
      if (preferred.has(candidate.agent.id)) score += this.maxLearningBonus * Math.max(0.25, hints.confidence);
      if (avoided.has(candidate.agent.id)) score -= this.maxLearningBonus * Math.max(0.25, hints.confidence);
      scores.set(candidate.agent.id, Math.max(-this.maxLearningBonus, Math.min(this.maxLearningBonus, score)));
    }
    return scores;
  }

  async getAgentExperience(agentId: string): Promise<AgentExperience> {
    const entries = await this.memory.listEntries({ subject: agentId, agentId });
    const outcomes = entries.filter((entry) => entry.type === 'agent-experience');
    const successes = outcomes.filter((entry) => Number(entry.metadata.success) === 1).length;
    const failures = outcomes.length - successes;
    const capabilityTaskAssociations: Record<string, number> = {};
    const preferredTaskClasses: Record<string, number> = {};
    const recentFailures: AgentExperience['recentFailures'] = [];
    const learnedPatterns: string[] = [];
    let totalLatency = 0;
    for (const entry of outcomes) {
      const taskType = String(entry.metadata.taskType ?? 'unknown');
      preferredTaskClasses[taskType] = (preferredTaskClasses[taskType] ?? 0) + (Number(entry.metadata.success) === 1 ? 1 : 0);
      totalLatency += Number(entry.metadata.executionTimeMs ?? 0);
      for (const tag of entry.tags.filter((item) => item.startsWith('capability:'))) {
        const capability = tag.slice(11);
        capabilityTaskAssociations[capability] = (capabilityTaskAssociations[capability] ?? 0) + 1;
      }
      if (Number(entry.metadata.success) !== 1) recentFailures.push({ taskType, timestamp: entry.updatedAt, errorCategory: String(entry.metadata.errorCategory ?? 'execution') });
      if (entry.type === 'agent-experience') learnedPatterns.push(entry.content);
    }
    return { agentId, successfulTaskCount: successes, failedTaskCount: failures, successRate: outcomes.length ? successes / outcomes.length : 0, averageExecutionTimeMs: outcomes.length ? totalLatency / outcomes.length : 0, capabilityTaskAssociations, preferredTaskClasses, recentFailures: recentFailures.slice(-10), learnedPatterns: learnedPatterns.slice(-20) };
  }

  async recordSandboxResult(executionId: string, result: unknown): Promise<MemoryEntry> {
    const sanitizedResult = JSON.stringify(sanitizeExecutionResult(result));
    return this.memory.create({
      namespace: 'global',
      type: 'observation',
      content: 'Sandbox execution result persisted as a sanitized observation',
      metadata: { executionId, source: 'sandbox', sanitizedResult: sanitizedResult.slice(0, 8_192) },
      source: 'sandbox',
      confidence: 0.7,
      tags: ['sandbox', 'execution-result'],
      provenance: { sourceType: 'system', sourceId: executionId, timestamp: timestamp(), confidence: 0.7, executionId },
      accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' },
    });
  }

  private async recordOutcome(input: TaskOutcomeLearningInput, success: boolean): Promise<MemoryEntry[]> {
    const outcomeKey = `${input.executionId}:${input.taskId}:${input.attempts}`;
    const existing = await this.memory.listEntries({ subject: 'system', canReadPrivate: true });
    if (existing.some((entry) => entry.metadata.outcomeKey === outcomeKey)) return [];
    const now = timestamp();
    const capabilities = [...new Set(input.capabilities)].slice(0, 32);
    const metadata = { outcomeKey, taskType: input.taskType, agentId: input.agentId, executionId: input.executionId, taskId: input.taskId, success: success ? 1 : 0, executionTimeMs: Math.max(0, input.executionTimeMs), attempts: input.attempts, ...(input.metadata ?? {}), ...(success ? {} : { errorCategory: safeErrorCategory(input.error ?? 'execution failure') }) };
    const evidenceConfidence = success ? Math.max(0.1, Math.min(1, input.quality)) : Math.max(0.7, Math.min(1, 0.7 + input.attempts * 0.05));
    const publicEntry = await this.memory.create({
      namespace: 'global',
      type: success ? 'routing-hint' : 'failure',
      content: success ? `Successful ${input.taskType} outcome for agent ${input.agentId}` : `Failed ${input.taskType} outcome for agent ${input.agentId}`,
      metadata,
      source: 'learning-engine',
      agentId: input.agentId,
      ...(input.swarmId ? { swarmId: input.swarmId } : {}),
      taskId: input.taskId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      confidence: evidenceConfidence,
      tags: [`task:${input.taskType}`, ...capabilities.map((capability) => `capability:${capability}`), success ? 'outcome:success' : 'outcome:failure'],
      provenance: taskOutcomeProvenance(input),
      accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: input.swarmId ? [input.swarmId] : [], owner: 'system' },
    });
    const experience = await this.memory.create({
      namespace: `agent:${input.agentId}`,
      type: 'agent-experience',
      content: `${success ? 'Succeeded' : 'Failed'} ${input.taskType}; experience is historical evidence, not an instruction`,
      metadata,
      source: 'learning-engine',
      agentId: input.agentId,
      taskId: input.taskId,
      confidence: evidenceConfidence,
      tags: capabilities.map((capability) => `capability:${capability}`),
      provenance: taskOutcomeProvenance(input),
      accessPolicy: { visibility: 'private', allowedSubjects: [input.agentId], allowedSwarmIds: input.swarmId ? [input.swarmId] : [], owner: input.agentId },
    }, { subject: input.agentId, agentId: input.agentId });
    const solution = await this.memory.create({
      namespace: 'global',
      type: success ? 'solution' : 'pattern',
      content: success ? `Capability combination ${capabilities.join(', ') || 'none'} worked for ${input.taskType}` : `Failure pattern for ${input.taskType}: ${safeErrorCategory(input.error ?? 'execution failure')}`,
      metadata: { ...metadata, ...(input.output !== undefined ? { outputSummary: JSON.stringify(sanitizeExecutionResult(input.output)).slice(0, 2_000) } : {}) },
      source: 'learning-engine',
      agentId: input.agentId,
      taskId: input.taskId,
      confidence: evidenceConfidence,
      tags: [`task:${input.taskType}`, ...capabilities.map((capability) => `capability:${capability}`), success ? 'solution' : 'failure-pattern'],
      provenance: taskOutcomeProvenance(input),
      accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: input.swarmId ? [input.swarmId] : [], owner: 'system' },
    });
    return [publicEntry, experience, solution];
  }

  private aggregateSignals(entries: MemoryEntry[], request: RoutingRequest): RoutingLearningSignal[] {
    const grouped = new Map<string, RoutingLearningSignal>();
    const now = Date.now();
    for (const entry of entries) {
      const agentId = String(entry.metadata.agentId ?? entry.agentId ?? 'unknown');
      const success = Number(entry.metadata.success) === 1;
      const previous = grouped.get(agentId) ?? { agentId, taskType: request.taskType, capabilityOverlap: 0, successRate: 0, successes: 0, failures: 0, repeatedFailures: 0, confidence: 0, decayedScore: 0, lastUpdated: entry.updatedAt };
      const ageDays = Math.max(0, (now - Date.parse(entry.updatedAt)) / 86_400_000);
      const decay = Math.exp(-Math.LN2 * ageDays / this.halfLifeDays);
      previous.successes += success ? 1 : 0;
      previous.failures += success ? 0 : 1;
      previous.repeatedFailures = success ? previous.repeatedFailures : previous.repeatedFailures + 1;
      previous.successRate = previous.successes / Math.max(1, previous.successes + previous.failures);
      previous.confidence = Math.max(previous.confidence, entry.confidence);
      previous.decayedScore += (success ? 1 : -1) * decay * entry.confidence;
      previous.lastUpdated = previous.lastUpdated > entry.updatedAt ? previous.lastUpdated : entry.updatedAt;
      grouped.set(agentId, previous);
    }
    return [...grouped.values()].map((signal) => ({ ...signal, decayedScore: Math.max(-1, Math.min(1, signal.decayedScore / Math.max(1, signal.successes + signal.failures))) }));
  }
}
