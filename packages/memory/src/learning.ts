import type { AgentId } from '../../core/src/index.js';
import type { AgentScheduler, SchedulerTask } from '../../scheduler/src/index.js';
import { MemoryStore, type MemoryHit } from './index.js';

export interface LearningOutcome {
  task: SchedulerTask;
  agentId: AgentId;
  success: boolean;
  quality: number;
  summary?: string;
}

export interface RoutingHint {
  agentId: AgentId;
  score: number;
  reason: string;
}

/** Local post-task learning loop. It deliberately uses lexical memory so it remains deterministic and dependency-free. */
export class LearningLoop {
  constructor(private readonly memory: MemoryStore) {}

  async recordOutcome(outcome: LearningOutcome): Promise<void> {
    const namespace = 'helix:patterns';
    const content = [
      `task=${outcome.task.title}`,
      `description=${outcome.task.description}`,
      `capabilities=${outcome.task.requiredCapabilities.join(',')}`,
      `success=${outcome.success}`,
      `quality=${outcome.quality}`,
      outcome.summary ? `summary=${outcome.summary}` : '',
    ].filter(Boolean).join(' | ');
    await this.memory.store({
      namespace,
      owner: outcome.agentId,
      content,
      importance: outcome.success ? 0.85 : 0.45,
      confidence: Math.max(0, Math.min(1, outcome.quality)),
      source: { agentId: outcome.agentId },
      allowedSubjects: ['*'],
    });
  }

  async recall(task: Pick<SchedulerTask, 'title' | 'description' | 'requiredCapabilities'>, subject = '*', limit = 5): Promise<MemoryHit[]> {
    const query = `${task.title} ${task.description} ${task.requiredCapabilities.join(' ')}`;
    return this.memory.search({ query, namespace: 'helix:patterns', subject, limit });
  }

  async hints(task: Pick<SchedulerTask, 'title' | 'description' | 'requiredCapabilities'>, subject = '*'): Promise<RoutingHint[]> {
    const hits = await this.recall(task, subject, 20);
    const byAgent = new Map<string, { score: number; count: number }>();
    for (const hit of hits) {
      const agentId = hit.record.source.agentId;
      if (!agentId) continue;
      const current = byAgent.get(agentId) ?? { score: 0, count: 0 };
      byAgent.set(agentId, { score: current.score + hit.score, count: current.count + 1 });
    }
    return [...byAgent.entries()]
      .map(([agentId, value]) => ({ agentId, score: value.score / value.count, reason: `recalled ${value.count} related execution pattern(s)` }))
      .sort((a, b) => b.score - a.score);
  }

  attachSchedulerOutcome(scheduler: AgentScheduler, callback: (outcome: LearningOutcome) => Promise<void>): () => void {
    const unsubscribeCompleted = scheduler.on('task.completed', (event) => {
      if (!event.taskId || !event.agentId) return;
      void callback({ task: scheduler.get(event.taskId), agentId: event.agentId, success: true, quality: 1 });
    });
    const unsubscribeFailed = scheduler.on('task.failed', (event) => {
      if (!event.taskId || !event.agentId) return;
      void callback({ task: scheduler.get(event.taskId), agentId: event.agentId, success: false, quality: 0 });
    });
    return () => { unsubscribeCompleted(); unsubscribeFailed(); };
  }
}
