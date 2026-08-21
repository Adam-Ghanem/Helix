import type { AgentId } from '../../core/src/index.js';
import type { MemorySearchResult } from '../../memory/src/index.js';
import type { IntelligenceAgentSelector } from './agent-selector.js';
import type { ExecutionPlan, Goal, GoalAnalysis, PlanStep, ReplanDecision, ReplanTrigger } from './types.js';
import type { HelixRuntime } from '../../runtime/src/index.js';

export class IntelligenceReplanner {
  constructor(private readonly runtime: HelixRuntime, private readonly selector: IntelligenceAgentSelector) {}
  async decide(input: { goal: Goal; analysis: GoalAnalysis; plan: ExecutionPlan; step: PlanStep; trigger: ReplanTrigger; cause: string; failedAgentId?: AgentId; subject?: string }): Promise<ReplanDecision> {
    const hints: MemorySearchResult[] = await this.runtime.searchMemory({ query: `${input.step.title} ${input.cause}`, namespace: 'global', types: ['failure', 'solution', 'pattern', 'routing-hint'], limit: 8, context: { subject: input.subject ?? 'orchestrator' } });
    const excluded = input.failedAgentId ? [input.failedAgentId] : [];
    let alternativeAgentId: AgentId | undefined;
    try { alternativeAgentId = (await this.selector.select(input.step, input.analysis, excluded)).selectedAgentId; } catch { alternativeAgentId = undefined; }
    const modifiedStep: PlanStep = { ...input.step, description: `${input.step.description} Replanned after ${input.trigger}: ${input.cause}`, preferredAgentTypes: [...new Set([...input.step.preferredAgentTypes, 'alternative'])], maxRetries: input.plan.limits.maxRetriesPerStep };
    return { triggered: true, trigger: input.trigger, failedStepId: input.step.id, cause: input.cause, ...(alternativeAgentId ? { alternativeAgentId } : {}), modifiedStep, rationale: [`trigger=${input.trigger}`, `failedStep=${input.step.id}`, `alternativeAgent=${alternativeAgentId ?? 'none'}`, `recalledMemories=${hints.length}`, 'replan is bounded by plan.maxReplans and maxIterations'], memoryHints: hints.map((hint) => hint.explanation).slice(0, 5) };
  }
  apply(plan: ExecutionPlan, decision: ReplanDecision): ExecutionPlan {
    if (!decision.modifiedStep || !decision.failedStepId) return structuredClone(plan);
    return { ...structuredClone(plan), steps: plan.steps.map((step) => step.id === decision.failedStepId ? structuredClone(decision.modifiedStep!) : structuredClone(step)), dependencies: { ...plan.dependencies, [decision.failedStepId]: [...(decision.modifiedStep.dependencies ?? [])] } };
  }
}
