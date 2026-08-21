import type { AgentProfile } from '../../core/src/index.js';
import type { ExecutionPlan, Goal, PlanTopology, PlanValidationIssue, PlanValidationResult } from './types.js';

const complexityValues = new Set(['low', 'medium', 'high', 'very-high']);
const topologyValues = new Set<PlanTopology>(['sequential', 'parallel', 'pipeline', 'hierarchical', 'mesh', 'adaptive']);

export class PlanValidator {
  validate(plan: ExecutionPlan, goal: Goal, agents: AgentProfile[]): PlanValidationResult {
    const errors: PlanValidationIssue[] = [];
    const warnings: PlanValidationIssue[] = [];
    const ids = new Set<string>();
    if (!plan.steps.length) errors.push({ code: 'empty_plan', message: 'plan must contain at least one step', severity: 'error' });
    if (plan.steps.length > plan.limits.maxTasks) errors.push({ code: 'max_tasks', message: `plan has ${plan.steps.length} steps above maxTasks=${plan.limits.maxTasks}`, severity: 'error' });
    if (!topologyValues.has(plan.recommendedTopology)) errors.push({ code: 'topology', message: `unsupported topology: ${plan.recommendedTopology}`, severity: 'error' });
    if (goal.risk === 'CRITICAL' && !goal.constraints.requireApproval) warnings.push({ code: 'approval_required', message: 'critical plans should explicitly require approval', severity: 'warning' });
    for (const step of plan.steps) {
      if (ids.has(step.id)) errors.push({ code: 'duplicate_step', message: `duplicate step id ${step.id}`, stepId: step.id, severity: 'error' });
      ids.add(step.id);
      if (!Number.isInteger(step.priority) || step.priority < 1 || step.priority > 10) errors.push({ code: 'priority', message: `step priority must be an integer from 1 to 10`, stepId: step.id, severity: 'error' });
      if (!complexityValues.has(step.estimatedComplexity)) errors.push({ code: 'complexity', message: `invalid complexity ${step.estimatedComplexity}`, stepId: step.id, severity: 'error' });
      if (step.depth > plan.limits.maxDepth) errors.push({ code: 'max_depth', message: `step depth ${step.depth} exceeds maxDepth=${plan.limits.maxDepth}`, stepId: step.id, severity: 'error' });
      if (step.dependencies.length > plan.limits.maxFanout) errors.push({ code: 'max_fanout', message: `step has ${step.dependencies.length} dependencies above maxFanout=${plan.limits.maxFanout}`, stepId: step.id, severity: 'error' });
      for (const dependency of step.dependencies) if (!plan.steps.some((candidate) => candidate.id === dependency)) errors.push({ code: 'missing_dependency', message: `unknown dependency ${dependency}`, stepId: step.id, severity: 'error' });
      if (!step.requiredCapabilities.length) warnings.push({ code: 'no_capabilities', message: 'step has no explicit capabilities', stepId: step.id, severity: 'warning' });
    }
    try { this.assertAcyclic(plan); } catch (error) { errors.push({ code: 'cycle', message: error instanceof Error ? error.message : String(error), severity: 'error' }); }
    const satisfiableAgentIds = agents.filter((agent) => agent.status !== 'offline' && plan.steps.some((step) => step.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)))).map((agent) => agent.id);
    for (const step of plan.steps) if (!agents.some((agent) => agent.status !== 'offline' && step.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)))) errors.push({ code: 'unsatisfied_capability', message: `no available agent satisfies step capabilities ${step.requiredCapabilities.join(', ')}`, stepId: step.id, severity: 'error' });
    if ((plan.recommendedTopology === 'parallel' || plan.recommendedTopology === 'mesh') && !plan.steps.some((step) => step.parallelizable)) warnings.push({ code: 'topology_parallelism', message: `${plan.recommendedTopology} topology has no parallelizable steps`, severity: 'warning' });
    if ((plan.recommendedTopology === 'hierarchical' || plan.recommendedTopology === 'pipeline') && plan.steps.length < 2) warnings.push({ code: 'topology_depth', message: `${plan.recommendedTopology} topology has fewer than two steps`, severity: 'warning' });
    if (goal.risk === 'CRITICAL' && plan.recommendedTopology !== 'hierarchical') errors.push({ code: 'critical_topology', message: 'critical plans require hierarchical topology', severity: 'error' });
    if (goal.constraints.deniedCapabilities?.some((capability) => plan.requiredCapabilities.includes(capability))) errors.push({ code: 'denied_capability', message: 'plan requests a capability denied by goal constraints', severity: 'error' });
    return { valid: errors.length === 0, errors, warnings, checkedAt: new Date().toISOString(), satisfiableAgentIds, rationale: [`steps=${plan.steps.length}`, `errors=${errors.length}`, `warnings=${warnings.length}`, `satisfiableAgents=${satisfiableAgentIds.length}`] };
  }
  assertAcyclic(plan: ExecutionPlan): void {
    const visiting = new Set<string>(); const visited = new Set<string>();
    const walk = (id: string): void => { if (visiting.has(id)) throw new Error(`plan dependency cycle detected at ${id}`); if (visited.has(id)) return; visiting.add(id); const step = plan.steps.find((candidate) => candidate.id === id); if (!step) throw new Error(`plan dependency references missing step ${id}`); for (const dependency of step.dependencies) walk(dependency); visiting.delete(id); visited.add(id); };
    for (const step of plan.steps) walk(step.id);
  }
}
