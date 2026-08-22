import { id, timestamp } from '../../core/src/index.js';
import type { HelixRuntime } from '../../runtime/src/index.js';
import type { ControlPlaneSession, SessionInput } from './types.js';

export class SessionManager {
  private readonly sessions = new Map<string, ControlPlaneSession>();
  constructor(private readonly runtime: HelixRuntime, private readonly maxSessions = 256) {}

  create(input: SessionInput): ControlPlaneSession {
    const goal = input.goal.trim();
    if (!goal) throw new Error('session goal is required');
    const session: ControlPlaneSession = { id: id('session'), goal, createdAt: timestamp(), status: 'created', topology: input.topology ?? 'adaptive', agents: [], tasks: [], executions: [], memoryNamespace: `session:${id('memory').replace('memory_', '')}` };
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.maxSessions) { const first = this.sessions.keys().next().value as string | undefined; if (!first) break; this.sessions.delete(first); }
    return structuredClone(session);
  }

  get(sessionId: string): ControlPlaneSession { const session = this.sessions.get(sessionId); if (!session) throw new Error(`Unknown session: ${sessionId}`); return structuredClone(session); }
  list(): ControlPlaneSession[] { return structuredClone([...this.sessions.values()]); }

  async start(sessionId: string): Promise<ControlPlaneSession> {
    const session = this.require(sessionId);
    if (session.status === 'completed' || session.status === 'failed') throw new Error(`cannot start terminal session ${sessionId}`);
    session.status = 'running'; session.startedAt = timestamp();
    await this.runtime.events.append({ type: 'session.started', payload: { sessionId, goal: session.goal, topology: session.topology }, idempotencyKey: `session:${sessionId}:started` });
    return structuredClone(session);
  }

  async stop(sessionId: string, reason = 'operator requested stop'): Promise<ControlPlaneSession> {
    const session = this.require(sessionId);
    if (session.status === 'completed' || session.status === 'failed') return structuredClone(session);
    session.status = 'stopped'; session.completedAt = timestamp(); session.failure = reason;
    await this.runtime.events.append({ type: 'session.stopped', payload: { sessionId, reason }, idempotencyKey: `session:${sessionId}:stopped` });
    return structuredClone(session);
  }

  async execute(sessionId: string): Promise<ControlPlaneSession> {
    const session = this.require(sessionId);
    if (session.status === 'created') await this.start(sessionId);
    try {
      const execution = await this.runtime.execute({ goal: session.goal });
      session.executions.push(execution.id);
      session.tasks.push(...execution.taskIds);
      session.status = execution.status === 'completed' ? 'completed' : execution.status === 'cancelled' ? 'stopped' : 'failed';
      session.completedAt = timestamp();
      if (execution.error) session.failure = execution.error;
      await this.runtime.events.append({ type: `session.${session.status}`, payload: { sessionId, executionId: execution.id, status: session.status }, idempotencyKey: `session:${sessionId}:${execution.id}` });
    } catch (error) {
      session.status = 'failed'; session.completedAt = timestamp(); session.failure = error instanceof Error ? error.message : String(error);
    }
    return structuredClone(session);
  }

  private require(sessionId: string): ControlPlaneSession { const session = this.sessions.get(sessionId); if (!session) throw new Error(`Unknown session: ${sessionId}`); return session; }
}
