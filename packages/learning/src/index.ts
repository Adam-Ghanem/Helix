import { Evaluation } from '../../core/src/index.js';

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

  private upsert(key: string, kind: LearningPattern['kind'], taskType: string, score: number, evidence: string): LearningPattern {
    const existing = this.patterns.get(key);
    const pattern: LearningPattern = existing ? { ...existing, score: (existing.score * existing.samples + score) / (existing.samples + 1), samples: existing.samples + 1, lastSeen: new Date().toISOString(), evidence: [...existing.evidence.slice(-7), evidence] } : { id: `pattern_${this.patterns.size + 1}`, kind, key, score, samples: 1, lastSeen: new Date().toISOString(), evidence: [evidence] };
    this.patterns.set(key, pattern);
    return pattern;
  }
}

export * from './intelligence.js';
