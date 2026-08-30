import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Evaluation, id, timestamp } from '../../core/src/index.js';

export interface TrajectoryStep {
  taskType: string;
  agentId?: string;
  strategy?: string;
  tool?: string;
  latencyMs: number;
  costUsd: number;
  success: boolean;
}

export interface Trajectory {
  executionId: string;
  steps: TrajectoryStep[];
  evaluation: Evaluation;
}

export interface LearningPattern {
  id: string;
  kind: 'successful-strategy' | 'failed-strategy' | 'common-error' | 'tool-pattern' | 'routing-pattern' | 'workflow-pattern';
  key: string;
  score: number;
  samples: number;
  lastSeen: string;
  evidence: string[];
}

export interface LearningFeedback {
  id: string;
  patternId: string;
  accepted: boolean;
  quality: number;
  note?: string | undefined;
  createdAt: string;
}

export interface DistilledStrategy {
  id: string;
  taskType: string;
  preferredPatterns: string[];
  avoidPatterns: string[];
  evidence: string[];
  updatedAt: string;
}

export class LearningEngine {
  private readonly patterns = new Map<string, LearningPattern>();

  record(trajectory: Trajectory): LearningPattern[] {
    const patterns: LearningPattern[] = [];
    for (const step of trajectory.steps) {
      const kind: LearningPattern['kind'] = step.success ? 'successful-strategy' : 'failed-strategy';
      const key = `${kind}:${step.taskType}:${step.strategy ?? 'unknown'}`;
      patterns.push(this.upsert(key, kind, step.taskType, step.success ? trajectory.evaluation.quality : 1 - trajectory.evaluation.quality, `${step.agentId ?? 'unassigned'}:${step.latencyMs}ms`));
      if (step.tool) patterns.push(this.upsert(`tool:${step.tool}`, 'tool-pattern', step.tool, step.success ? 1 : 0, trajectory.executionId));
    }
    return patterns.map((pattern) => structuredClone(pattern));
  }

  recommend(taskType: string): LearningPattern[] {
    return [...this.patterns.values()].filter((pattern) => pattern.key.includes(`:${taskType}:`) || pattern.key === `tool:${taskType}`).sort((left, right) => right.score - left.score).map((pattern) => structuredClone(pattern));
  }

  all(): LearningPattern[] {
    return [...this.patterns.values()].map((pattern) => structuredClone(pattern));
  }

  private upsert(key: string, kind: LearningPattern['kind'], _taskType: string, score: number, evidence: string): LearningPattern {
    const existing = this.patterns.get(key);
    const pattern: LearningPattern = existing ? { ...existing, score: (existing.score * existing.samples + score) / (existing.samples + 1), samples: existing.samples + 1, lastSeen: timestamp(), evidence: [...existing.evidence.slice(-7), evidence] } : { id: `pattern_${this.patterns.size + 1}`, kind, key, score, samples: 1, lastSeen: timestamp(), evidence: [evidence] };
    this.patterns.set(key, pattern);
    return pattern;
  }
}

interface DurableLearningState {
  version: 1;
  trajectories: Trajectory[];
  patterns: LearningPattern[];
  feedback: LearningFeedback[];
  strategies: DistilledStrategy[];
}

export class DurableLearningEngine {
  private readonly stateFile: string;
  private readonly maxTrajectories: number;
  private readonly halfLifeDays: number;
  private readonly trajectoryList: Trajectory[] = [];
  private readonly patterns = new Map<string, LearningPattern>();
  private readonly feedbackList: LearningFeedback[] = [];
  private readonly strategies = new Map<string, DistilledStrategy>();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { stateFile: string; maxTrajectories?: number; halfLifeDays?: number }) {
    this.stateFile = options.stateFile;
    this.maxTrajectories = options.maxTrajectories ?? 1_000;
    this.halfLifeDays = options.halfLifeDays ?? 30;
    if (!Number.isInteger(this.maxTrajectories) || this.maxTrajectories < 1) throw new Error('maxTrajectories must be a positive integer');
    if (!Number.isFinite(this.halfLifeDays) || this.halfLifeDays <= 0) throw new Error('halfLifeDays must be positive');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.stateFile), { recursive: true });
    try {
      const state = JSON.parse(await readFile(this.stateFile, 'utf8')) as DurableLearningState;
      if (state.version !== 1 || !Array.isArray(state.trajectories) || !Array.isArray(state.patterns) || !Array.isArray(state.feedback) || !Array.isArray(state.strategies)) throw new Error('Unsupported learning state');
      this.trajectoryList.push(...state.trajectories.map((item) => structuredClone(item)));
      for (const pattern of state.patterns) this.patterns.set(pattern.id, structuredClone(pattern));
      this.feedbackList.push(...state.feedback.map((item) => structuredClone(item)));
      for (const strategy of state.strategies) this.strategies.set(strategy.taskType, structuredClone(strategy));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async record(trajectory: Trajectory): Promise<LearningPattern[]> {
    await this.init();
    this.trajectoryList.push(structuredClone(trajectory));
    while (this.trajectoryList.length > this.maxTrajectories) this.trajectoryList.shift();
    const updated: LearningPattern[] = [];
    for (const step of trajectory.steps) {
      const kind: LearningPattern['kind'] = step.success ? 'successful-strategy' : 'failed-strategy';
      const key = `${kind}:${step.taskType}:${step.strategy ?? 'unknown'}`;
      updated.push(this.upsertPattern(key, kind, step.success ? trajectory.evaluation.quality : 1 - trajectory.evaluation.quality, `${trajectory.executionId}:${step.agentId ?? 'unassigned'}:${step.latencyMs}ms`));
      if (step.tool) updated.push(this.upsertPattern(`tool:${step.tool}`, 'tool-pattern', step.success ? 1 : 0, trajectory.executionId));
    }
    await this.persist();
    return updated.map((pattern) => structuredClone(pattern));
  }

  async feedback(input: { patternId: string; accepted: boolean; quality: number; note?: string }): Promise<LearningFeedback> {
    await this.init();
    if (!this.patterns.has(input.patternId)) throw new Error(`Unknown learning pattern: ${input.patternId}`);
    const record: LearningFeedback = { id: id('feedback'), patternId: input.patternId, accepted: input.accepted, quality: clamp(input.quality), ...(input.note ? { note: input.note } : {}), createdAt: timestamp() };
    this.feedbackList.push(record);
    await this.persist();
    return structuredClone(record);
  }

  async recommend(taskType: string, options: { limit?: number; now?: number } = {}): Promise<LearningPattern[]> {
    await this.init();
    const now = options.now ?? Date.now();
    const candidates = [...this.patterns.values()].filter((pattern) => pattern.key.includes(`:${taskType}:`) || pattern.key === `tool:${taskType}`);
    candidates.sort((left, right) => this.rank(right, now) - this.rank(left, now) || right.samples - left.samples || left.key.localeCompare(right.key));
    return candidates.slice(0, options.limit ?? 20).map((pattern) => structuredClone(pattern));
  }

  async trajectories(): Promise<Trajectory[]> {
    await this.init();
    return this.trajectoryList.map((trajectory) => structuredClone(trajectory));
  }

  async all(): Promise<LearningPattern[]> {
    await this.init();
    return [...this.patterns.values()].map((pattern) => structuredClone(pattern));
  }

  async distilled(): Promise<DistilledStrategy[]> {
    await this.init();
    return [...this.strategies.values()].map((strategy) => structuredClone(strategy));
  }

  async distill(taskType: string): Promise<DistilledStrategy> {
    await this.init();
    const matching = [...this.patterns.values()].filter((pattern) => pattern.key.includes(`:${taskType}:`));
    const successful = matching.filter((pattern) => pattern.kind === 'successful-strategy').sort((a, b) => this.rank(b, Date.now()) - this.rank(a, Date.now())).slice(0, 5);
    const failed = matching.filter((pattern) => pattern.kind === 'failed-strategy').sort((a, b) => b.score - a.score || b.samples - a.samples).slice(0, 5);
    const existing = this.strategies.get(taskType);
    const strategy: DistilledStrategy = {
      id: existing?.id ?? id('strategy'),
      taskType,
      preferredPatterns: successful.map((pattern) => pattern.key),
      avoidPatterns: failed.map((pattern) => pattern.key),
      evidence: [...new Set([...successful.flatMap((pattern) => pattern.evidence), ...failed.flatMap((pattern) => pattern.evidence)])].slice(-50),
      updatedAt: timestamp(),
    };
    this.strategies.set(taskType, strategy);
    await this.persist();
    return structuredClone(strategy);
  }

  async consolidate(options: { now?: number } = {}): Promise<{ prunedPatterns: number; retainedTrajectories: number }> {
    await this.init();
    const now = options.now ?? Date.now();
    while (this.trajectoryList.length > this.maxTrajectories) this.trajectoryList.shift();
    let prunedPatterns = 0;
    for (const [patternId, pattern] of this.patterns) {
      const ageDays = Math.max(0, (now - Date.parse(pattern.lastSeen)) / 86_400_000);
      const decay = Math.pow(0.5, ageDays / this.halfLifeDays);
      const feedbackCount = this.feedbackList.filter((record) => record.patternId === pattern.id).length;
      if (decay < 0.01 && pattern.samples < 3 && feedbackCount === 0) {
        this.patterns.delete(patternId);
        prunedPatterns += 1;
      }
    }
    const surviving = new Set(this.patterns.values().map((pattern) => pattern.key));
    for (const [taskType, strategy] of this.strategies) {
      strategy.preferredPatterns = strategy.preferredPatterns.filter((key) => surviving.has(key));
      strategy.avoidPatterns = strategy.avoidPatterns.filter((key) => surviving.has(key));
      strategy.updatedAt = timestamp();
      this.strategies.set(taskType, strategy);
    }
    await this.persist();
    return { prunedPatterns, retainedTrajectories: this.trajectoryList.length };
  }

  private upsertPattern(key: string, kind: LearningPattern['kind'], score: number, evidence: string): LearningPattern {
    const existing = [...this.patterns.values()].find((pattern) => pattern.key === key);
    if (existing) {
      existing.score = (existing.score * existing.samples + clamp(score)) / (existing.samples + 1);
      existing.samples += 1;
      existing.lastSeen = timestamp();
      existing.evidence = [...existing.evidence.slice(-15), evidence];
      return existing;
    }
    const pattern: LearningPattern = { id: id('pattern'), kind, key, score: clamp(score), samples: 1, lastSeen: timestamp(), evidence: [evidence] };
    this.patterns.set(pattern.id, pattern);
    return pattern;
  }

  private rank(pattern: LearningPattern, now: number): number {
    const ageDays = Math.max(0, (now - Date.parse(pattern.lastSeen)) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / this.halfLifeDays);
    const confidence = Math.min(1, Math.log2(pattern.samples + 1) / 4);
    const feedback = this.feedbackList.filter((record) => record.patternId === pattern.id);
    const feedbackScore = feedback.length ? feedback.reduce((sum, record) => sum + (record.accepted ? record.quality : 0), 0) / feedback.length : 0.5;
    const kindWeight = pattern.kind === 'failed-strategy' ? 0.35 : 1;
    return kindWeight * (0.55 * pattern.score + 0.25 * feedbackScore + 0.10 * confidence + 0.10 * recency);
  }

  private persist(): Promise<void> {
    const write = async () => {
      const state: DurableLearningState = {
        version: 1,
        trajectories: this.trajectoryList.map((item) => structuredClone(item)),
        patterns: [...this.patterns.values()].map((item) => structuredClone(item)),
        feedback: this.feedbackList.map((item) => structuredClone(item)),
        strategies: [...this.strategies.values()].map((item) => structuredClone(item)),
      };
      const temp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temp, this.stateFile);
    };
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
