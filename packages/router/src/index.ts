import { AgentProfile, AgentId } from '../../core/src/index.js';

export type RoutingStrategy = 'round-robin' | 'capability' | 'quality' | 'cost' | 'latency' | 'hybrid' | 'adaptive';

export interface RoutingRequest {
  taskType: string;
  requiredCapabilities: string[];
  complexity: number;
  maxCostUsd?: number;
  securityLevel?: 'standard' | 'sensitive' | 'critical';
}

export interface RoutingCandidate {
  agent: AgentProfile;
  estimatedCostUsd: number;
  availability: number;
  memoryRelevance: number;
  learningBonus?: number;
}

export interface RoutingDecision {
  agentId: AgentId;
  strategy: RoutingStrategy;
  score: number;
  candidates: Array<{ agentId: AgentId; score: number }>;
  rationale: string[];
}

export class AgentRouter {
  private cursor = 0;
  private readonly strategies = new Map<RoutingStrategy, (request: RoutingRequest, candidates: RoutingCandidate[]) => RoutingDecision>();

  constructor() {
    this.strategies.set('round-robin', (request, candidates) => this.choose(request, candidates, 'round-robin', (candidate, index) => 1 - ((index + this.cursor) % candidates.length) / candidates.length));
    this.strategies.set('capability', (request, candidates) => this.choose(request, candidates, 'capability', (candidate) => this.capabilityScore(request, candidate)));
    this.strategies.set('quality', (request, candidates) => this.choose(request, candidates, 'quality', (candidate) => candidate.agent.health.qualityScore));
    this.strategies.set('cost', (request, candidates) => this.choose(request, candidates, 'cost', (candidate) => 1 - Math.min(1, candidate.estimatedCostUsd / Math.max(0.01, request.maxCostUsd ?? 1))));
    this.strategies.set('latency', (request, candidates) => this.choose(request, candidates, 'latency', (candidate) => 1 - Math.min(1, candidate.agent.health.latencyMs / 30_000)));
    this.strategies.set('hybrid', (request, candidates) => this.choose(request, candidates, 'hybrid', (candidate) => {
      const capability = this.capabilityScore(request, candidate);
      const quality = candidate.agent.health.qualityScore;
      const latency = 1 - Math.min(1, candidate.agent.health.latencyMs / 30_000);
      const cost = 1 - Math.min(1, candidate.estimatedCostUsd / Math.max(0.01, request.maxCostUsd ?? 1));
      return 0.30 * capability + 0.25 * quality + 0.15 * latency + 0.15 * cost + 0.10 * candidate.availability + 0.05 * candidate.memoryRelevance;
    }));
    this.strategies.set('adaptive', (request, candidates) => this.choose(request, candidates, 'adaptive', (candidate) => {
      const base = 0.55 * this.capabilityScore(request, candidate) + 0.30 * candidate.agent.health.qualityScore + 0.15 * candidate.availability;
      const exploration = 1 / Math.sqrt(candidate.agent.health.samples + 1);
      const boundedLearning = Math.max(-0.1, Math.min(0.1, candidate.learningBonus ?? 0));
      return Math.min(1, Math.max(0, base + 0.15 * exploration + boundedLearning));
    }));
  }

  register(strategy: RoutingStrategy, scorer: (request: RoutingRequest, candidates: RoutingCandidate[]) => RoutingDecision): void {
    this.strategies.set(strategy, scorer);
  }

  route(request: RoutingRequest, candidates: RoutingCandidate[], strategy: RoutingStrategy = 'adaptive'): RoutingDecision {
    const available = candidates.filter((candidate) => candidate.agent.status !== 'offline' && candidate.availability > 0);
    const capabilityMatched = available.filter((candidate) => this.capabilityScore(request, candidate) === 1);
    const eligible = request.requiredCapabilities.length && capabilityMatched.length ? capabilityMatched : available;
    if (!eligible.length || (request.requiredCapabilities.length > 0 && !capabilityMatched.length)) throw new Error('No available agent satisfies the routing request');
    const chooser = this.strategies.get(strategy);
    if (!chooser) throw new Error(`Unknown routing strategy: ${strategy}`);
    const decision = chooser(request, eligible);
    this.cursor = (this.cursor + 1) % Math.max(1, eligible.length);
    return decision;
  }

  private choose(request: RoutingRequest, candidates: RoutingCandidate[], strategy: RoutingStrategy, score: (candidate: RoutingCandidate, index: number) => number): RoutingDecision {
    const scored = candidates.map((candidate, index) => ({ candidate, score: Math.max(0, Math.min(1, score(candidate, index))) }));
    scored.sort((left, right) => right.score - left.score || left.candidate.agent.id.localeCompare(right.candidate.agent.id));
    const winner = scored[0]!;
    const rationale = [
      `strategy=${request.taskType}`,
      `capabilities=${this.capabilityScore(request, winner.candidate).toFixed(2)}`,
      `quality=${winner.candidate.agent.health.qualityScore.toFixed(2)}`,
      `availability=${winner.candidate.availability.toFixed(2)}`,
      ...(winner.candidate.learningBonus !== undefined && winner.candidate.learningBonus !== 0 ? [`learningBonus=${winner.candidate.learningBonus.toFixed(3)}`] : []),
    ];
    return {
      agentId: winner.candidate.agent.id,
      strategy,
      score: winner.score,
      candidates: scored.map(({ candidate, score: candidateScore }) => ({ agentId: candidate.agent.id, score: candidateScore })),
      rationale,
    };
  }

  private capabilityScore(request: RoutingRequest, candidate: RoutingCandidate): number {
    if (!request.requiredCapabilities.length) return 1;
    const capabilities = new Set(candidate.agent.capabilities);
    return request.requiredCapabilities.filter((capability) => capabilities.has(capability)).length / request.requiredCapabilities.length;
  }
}
