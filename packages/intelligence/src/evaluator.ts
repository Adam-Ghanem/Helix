import type { AgentProfile } from '../../core/src/index.js';
import type { ExecutionPlan, Goal, GoalAnalysis, EvaluationResult, StepExecutionRecord } from './types.js';

export class OrchestrationEvaluator {
  evaluate(goal: Goal, analysis: GoalAnalysis, plan: ExecutionPlan, steps: StepExecutionRecord[], agents: AgentProfile[]): EvaluationResult {
    const completed = steps.filter((step) => step.status === 'completed').length;
    const failed = steps.filter((step) => step.status === 'failed').length;
    const dependencyCompletion = plan.steps.length ? plan.steps.filter((step) => step.dependencies.every((dependency) => steps.find((record) => record.stepId === dependency)?.status === 'completed')).length / plan.steps.length : 0;
    const outputPresence = completed ? steps.filter((step) => step.status === 'completed' && step.output !== undefined).length / completed : 0;
    const retries = steps.reduce((sum, step) => sum + Math.max(0, step.attempts - 1), 0);
    const retryPenalty = Math.min(1, retries / Math.max(1, plan.steps.length * 2));
    const timeoutCount = steps.filter((step) => /timeout|timed out/i.test(step.error ?? '')).length;
    const selectedIds = new Set(steps.flatMap((step) => step.agentId ? [step.agentId] : []));
    const selectedAgents = agents.filter((agent) => selectedIds.has(agent.id));
    const agentReliability = selectedAgents.length ? selectedAgents.reduce((sum, agent) => sum + agent.health.successRate, 0) / selectedAgents.length : 0;
    const securityViolations = steps.filter((step) => /security|policy|unauthorized|forbidden|privileged/i.test(step.error ?? '')).length;
    const goalCoverage = plan.steps.length ? completed / plan.steps.length : 0;
    const score = Math.max(0, Math.min(1, 0.35 * goalCoverage + 0.2 * dependencyCompletion + 0.15 * outputPresence + 0.15 * agentReliability + 0.15 * (1 - retryPenalty) - Math.min(0.5, securityViolations * 0.25)));
    const warnings: string[] = [];
    const recommendations: string[] = [];
    if (failed) recommendations.push(`replan ${failed} failed step${failed === 1 ? '' : 's'} with bounded alternatives`);
    if (timeoutCount) warnings.push(`${timeoutCount} step${timeoutCount === 1 ? '' : 's'} timed out`);
    if (securityViolations) warnings.push(`${securityViolations} security/policy rejection${securityViolations === 1 ? '' : 's'} observed`);
    if (outputPresence < 1 && completed) recommendations.push('require structured output evidence for every completed step');
    if (analysis.risk === 'HIGH' || analysis.risk === 'CRITICAL') recommendations.push('retain mandatory security review before delivery');
    return { success: failed === 0 && securityViolations === 0 && goalCoverage === 1, score: Number(score.toFixed(4)), completedSteps: completed, failedSteps: failed, warnings, recommendations, dependencyCompletion: Number(dependencyCompletion.toFixed(4)), outputPresence: Number(outputPresence.toFixed(4)), retryPenalty: Number(retryPenalty.toFixed(4)), timeoutCount, agentReliability: Number(agentReliability.toFixed(4)), securityViolations, goalCoverage: Number(goalCoverage.toFixed(4)) };
  }
}
