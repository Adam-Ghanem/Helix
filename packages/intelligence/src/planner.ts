import { id, timestamp } from '../../core/src/index.js';
import { decomposeGoal } from './decomposer.js';
import type { ExecutionPlan, Goal, GoalAnalysis, GoalConstraints, PlanTopology } from './types.js';

export const DEFAULT_INTELLIGENCE_LIMITS: Required<Pick<GoalConstraints, 'maxDepth' | 'maxTasks' | 'maxFanout' | 'maxReplans' | 'maxRetriesPerStep' | 'maxIterations'>> = { maxDepth: 8, maxTasks: 64, maxFanout: 8, maxReplans: 3, maxRetriesPerStep: 2, maxIterations: 5 };

function complexityRank(value: GoalAnalysis['complexity']): number { return value === 'low' ? 1 : value === 'medium' ? 2 : value === 'high' ? 3 : 4; }

export class IntelligencePlanner {
  constructor(private readonly defaults: Partial<typeof DEFAULT_INTELLIGENCE_LIMITS> = {}) {}
  create(goal: Goal, analysis: GoalAnalysis): ExecutionPlan {
    const limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...this.defaults, ...goal.constraints };
    if (limits.maxTasks < 1 || limits.maxDepth < 1 || limits.maxFanout < 1 || limits.maxReplans < 0 || limits.maxRetriesPerStep < 0 || limits.maxIterations < 1) throw new Error('planning limits must be positive, with retry/replan limits non-negative');
    const steps = decomposeGoal(goal, analysis, { maxTasks: limits.maxTasks, maxDepth: limits.maxDepth, maxFanout: limits.maxFanout, maxRetriesPerStep: limits.maxRetriesPerStep });
    const dependencies = Object.fromEntries(steps.map((step) => [step.id, [...step.dependencies]]));
    const topology = goal.constraints.requiredTopology ?? analysis.likelyTopology;
    return { id: id('plan'), goalId: goal.id, steps, dependencies, recommendedTopology: topology, requiredCapabilities: [...new Set(steps.flatMap((step) => step.requiredCapabilities))], estimatedComplexity: analysis.complexity, risk: goal.risk, createdAt: timestamp(), limits: { maxDepth: limits.maxDepth, maxTasks: limits.maxTasks, maxFanout: limits.maxFanout, maxReplans: limits.maxReplans, maxRetriesPerStep: limits.maxRetriesPerStep, maxIterations: limits.maxIterations } };
  }
  explain(plan: ExecutionPlan): string[] {
    const parallel = plan.steps.filter((step) => step.parallelizable).map((step) => step.id);
    return [`plan=${plan.id}`, `steps=${plan.steps.length}`, `topology=${plan.recommendedTopology}`, `risk=${plan.risk}`, `complexity=${complexityRank(plan.estimatedComplexity)}/4`, `parallelizable=${parallel.length ? parallel.join(',') : 'none'}`, `limits=maxDepth:${plan.limits.maxDepth},maxTasks:${plan.limits.maxTasks},maxFanout:${plan.limits.maxFanout}`];
  }
}
