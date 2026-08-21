import type { AgentId, AgentProfile } from '../../core/src/index.js';
import type { SchedulerTask } from './task.js';
import type { LoadManager } from './load.js';

export interface AgentScore {
  agentId: AgentId;
  score: number;
  capabilityMatch: number;
  availability: number;
  health: number;
  reputation: number;
  specialization: number;
}

export interface RoutingContext {
  task: SchedulerTask;
  agents: readonly AgentProfile[];
  load: LoadManager;
}

export interface RoutingStrategy {
  score(agent: AgentProfile, context: RoutingContext): AgentScore | undefined;
}

export class AdaptiveRoutingStrategy implements RoutingStrategy {
  score(agent: AgentProfile, context: RoutingContext): AgentScore | undefined {
    if (agent.status === 'offline' || agent.status === 'unhealthy') return undefined;
    const required = context.task.requiredCapabilities;
    const capabilities = new Set(agent.capabilities);
    if (required.some((capability) => !capabilities.has(capability))) return undefined;

    const capabilityMatch = required.length === 0 ? 1 : required.filter((capability) => capabilities.has(capability)).length / required.length;
    const availability = Math.max(0, 1 - context.load.utilization(agent.id));
    const health = Math.max(0, Math.min(1, agent.health.qualityScore * 0.6 + agent.health.successRate * 0.4));
    const reputation = context.agents.length === 0 ? 0 : Math.max(0, Math.min(1, agent.reputation.length > 0
      ? agent.reputation.reduce((sum, record) => sum + record.score, 0) / agent.reputation.length
      : agent.health.qualityScore));
    const specialization = agent.role.toLowerCase().includes(context.task.requiredCapabilities[0]?.toLowerCase() ?? '') ? 1 : 0;
    const score = capabilityMatch * 0.45 + availability * 0.2 + health * 0.15 + reputation * 0.15 + specialization * 0.05;
    return { agentId: agent.id, score, capabilityMatch, availability, health, reputation, specialization };
  }
}

export class AgentRouter {
  constructor(private readonly strategy: RoutingStrategy = new AdaptiveRoutingStrategy()) {}

  rank(context: RoutingContext): AgentScore[] {
    return context.agents
      .map((agent) => this.strategy.score(agent, context))
      .filter((score): score is AgentScore => score !== undefined)
      .sort((a, b) => b.score - a.score);
  }

  select(context: RoutingContext): AgentScore | undefined {
    return this.rank(context).find((candidate) => context.load.canReserve(candidate.agentId, false));
  }
}
