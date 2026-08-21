import { EventStore } from '../../durable/src/index.js';
import { AgentId, timestamp } from '../../core/src/index.js';
import type { RoutingDecision, RoutingRequest } from './index.js';

export interface RouteOutcome {
  success: boolean;
  quality: number;
  latencyMs: number;
  costUsd: number;
  tokens?: number;
  notes?: string[];
}

export interface RouteEvidence {
  request: RoutingRequest;
  decision: RoutingDecision;
  outcome?: RouteOutcome;
  recordedAt: string;
}

export class RoutingEvidenceStore {
  constructor(private readonly store: EventStore) {}

  async record(input: {
    request: RoutingRequest;
    decision: RoutingDecision;
    outcome?: RouteOutcome;
    executionId?: string;
    taskId?: string;
  }): Promise<void> {
    const evidence: RouteEvidence = {
      request: input.request,
      decision: input.decision,
      outcome: input.outcome,
      recordedAt: timestamp(),
    };
    await this.store.append({
      type: 'routing.evidence.recorded',
      executionId: input.executionId,
      taskId: input.taskId,
      agentId: input.decision.agentId,
      payload: evidence,
    });
  }

  async list(agentId?: AgentId): Promise<RouteEvidence[]> {
    const events = await this.store.read((event) => event.type === 'routing.evidence.recorded' && (!agentId || event.agentId === agentId));
    return events.map((event) => event.payload as RouteEvidence);
  }

  async summary(): Promise<Map<AgentId, { samples: number; successRate: number; quality: number; latencyMs: number; costUsd: number }>> {
    const summary = new Map<AgentId, { samples: number; successRate: number; quality: number; latencyMs: number; costUsd: number }>();
    const events = await this.store.read((event) => event.type === 'routing.evidence.recorded' && Boolean(event.agentId));
    for (const event of events) {
      const agentId = event.agentId!;
      const evidence = event.payload as RouteEvidence;
      const outcome = evidence.outcome;
      if (!outcome) continue;
      const current = summary.get(agentId) ?? { samples: 0, successRate: 0, quality: 0, latencyMs: 0, costUsd: 0 };
      current.samples += 1;
      current.successRate += outcome.success ? 1 : 0;
      current.quality += outcome.quality;
      current.latencyMs += outcome.latencyMs;
      current.costUsd += outcome.costUsd;
      summary.set(agentId, current);
    }
    for (const [agentId, value] of summary) {
      value.successRate /= value.samples;
      value.quality /= value.samples;
      value.latencyMs /= value.samples;
      value.costUsd /= value.samples;
      summary.set(agentId, value);
    }
    return summary;
  }
}
