import type { AgentProfile } from '../../core/src/index.js';
import type { AgentRouter, RoutingCandidate, RoutingRequest } from '../../router/src/index.js';
import type { PersistentLearningEngine } from '../../learning/src/intelligence.js';
import type { ExecutionPlan, GoalAnalysis, AgentSelection, AgentSelectionScore, SwarmTeam, PlanStep } from './types.js';
import { classifyTask } from './task-classifier.js';

export interface SelectionContext { agents: AgentProfile[]; router: AgentRouter; learning: PersistentLearningEngine; subject?: string; }

function availability(agent: AgentProfile): number { return agent.status === 'idle' ? 1 : agent.status === 'busy' ? 0.45 : agent.status === 'unhealthy' ? 0.1 : 0; }
function specialization(agent: AgentProfile, preferred: string[]): number { if (!preferred.length) return 0.5; const haystack = `${agent.name} ${agent.role}`.toLowerCase(); return preferred.some((value) => haystack.includes(value.toLowerCase())) ? 1 : 0.35; }
function reputation(agent: AgentProfile, taskType: string): number { return Math.max(0, Math.min(1, agent.reputation.find((record) => record.taskType === taskType)?.score ?? agent.health.qualityScore)); }

export class IntelligenceAgentSelector {
  constructor(private readonly context: SelectionContext) {}
  async select(step: PlanStep, analysis: GoalAnalysis, excluded: string[] = []): Promise<AgentSelection> {
    const classification = classifyTask(step, analysis);
    const request: RoutingRequest = { taskType: classification.taskType, requiredCapabilities: step.requiredCapabilities, complexity: analysis.complexityScore, securityLevel: analysis.risk === 'CRITICAL' ? 'critical' : analysis.risk === 'HIGH' ? 'sensitive' : 'standard' };
    const hints = await this.context.learning.suggestRouting(request, { subject: this.context.subject ?? 'orchestrator' });
    const preferred = new Set(hints.preferredAgents);
    const avoided = new Set(hints.avoidAgents);
    const excludedSet = new Set(excluded); const candidates = this.context.agents.filter((agent) => agent.status !== 'offline' && !excludedSet.has(agent.id) && step.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)));
    if (!candidates.length) throw new Error(`No available agent satisfies step capabilities: ${step.requiredCapabilities.join(', ')}`);
    const scored: AgentSelectionScore[] = candidates.map((agent) => {
      const agentAvailability = availability(agent);
      const health = Math.max(0, Math.min(1, agent.health.qualityScore));
      const agentReputation = reputation(agent, classification.taskType);
      const historicalSuccess = Math.max(0, Math.min(1, agent.health.successRate));
      const agentSpecialization = specialization(agent, step.preferredAgentTypes);
      const memoryBonus = preferred.has(agent.id) ? Math.min(0.1, Math.max(0, hints.confidence * 0.1)) : avoided.has(agent.id) ? -Math.min(0.1, Math.max(0, hints.confidence * 0.1)) : 0;
      const score = Math.max(0, Math.min(1, 0.32 * 1 + 0.18 * health + 0.15 * agentAvailability + 0.14 * agentReputation + 0.1 * agentSpecialization + 0.11 * historicalSuccess + memoryBonus));
      return { agentId: agent.id, score, capabilityMatch: 1, availability: agentAvailability, health, reputation: agentReputation, specialization: agentSpecialization, historicalSuccess, memoryBonus, rationale: [`capabilityMatch=1.00`, `availability=${agentAvailability.toFixed(2)}`, `health=${health.toFixed(2)}`, `reputation=${agentReputation.toFixed(2)}`, `specialization=${agentSpecialization.toFixed(2)}`, `historicalSuccess=${historicalSuccess.toFixed(2)}`, `memoryBonus=${memoryBonus.toFixed(3)}`] };
    });
    const routingCandidates: RoutingCandidate[] = candidates.map((agent) => ({ agent, estimatedCostUsd: 0, availability: availability(agent), memoryRelevance: preferred.has(agent.id) ? Math.min(1, hints.confidence) : 0.5, learningBonus: scored.find((candidate) => candidate.agentId === agent.id)!.memoryBonus }));
    const decision = this.context.router.route(request, routingCandidates, 'adaptive');
    const selected = scored.find((candidate) => candidate.agentId === decision.agentId) ?? scored[0]!;
    return { stepId: step.id, selectedAgentId: selected.agentId, candidates: scored.sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId)), decision, role: this.roleFor(step, analysis) };
  }
  async formTeam(plan: ExecutionPlan, analysis: GoalAnalysis): Promise<SwarmTeam> {
    const selections: AgentSelection[] = [];
    for (const step of plan.steps) selections.push(await this.select(step, analysis));
    const unique = [...new Set(selections.map((selection) => selection.selectedAgentId))];
    const coordinatorId = unique[0] ?? this.context.agents.find((agent) => agent.status === 'idle')?.id;
    if (!coordinatorId) throw new Error('No available coordinator agent');
    const members = unique.map((agentId) => {
      const selectedSteps = selections.filter((selection) => selection.selectedAgentId === agentId);
      const firstRole = selectedSteps.find((selection) => selection.role !== 'specialist')?.role ?? 'specialist';
      return { agentId, role: agentId === coordinatorId ? 'coordinator' as const : firstRole as 'implementer' | 'reviewer' | 'tester' | 'security' | 'specialist', stepIds: selectedSteps.map((selection) => selection.stepId) };
    });
    return { topology: plan.recommendedTopology, coordinatorId, members, selections, rationale: [`topology=${plan.recommendedTopology}`, `coordinator=${coordinatorId}`, `members=${members.length}`, `selectedSteps=${selections.length}`, `capabilityMatching=hard-constraint`] };
  }
  private roleFor(step: PlanStep, analysis: GoalAnalysis): string {
    if (step.requiredCapabilities.includes('security') || analysis.risk === 'CRITICAL') return 'security';
    if (step.requiredCapabilities.includes('testing')) return 'tester';
    if (step.requiredCapabilities.includes('review')) return 'reviewer';
    if (step.requiredCapabilities.includes('coding')) return 'implementer';
    return 'specialist';
  }
}
