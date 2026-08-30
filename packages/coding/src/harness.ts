import { AgentRegistry } from '../../agents/src/index.js';
import { HookEngine, HookEventName, HookRunResult } from '../../hooks/src/index.js';
import { MemoryStore } from '../../memory/src/index.js';
import { CodingAgentAdapter, CodingAgentRequest, CodingAgentResult } from './adapters/base.js';
import { CodingSessionStore } from './store.js';
import { CodingSessionRecord, JudgeVerdict, ReviewVerdict, TestVerdict } from './types.js';

export interface CodingHarnessOptions {
  store: CodingSessionStore;
  hooks: HookEngine;
  adapter: CodingAgentAdapter;
  memory?: MemoryStore;
  agents?: AgentRegistry;
  reviewer: (input: { session: CodingSessionRecord; implementation: CodingAgentResult; evidence: Awaited<ReturnType<CodingSessionStore['evidenceForSession']>> }) => Promise<ReviewVerdict>;
  tester: (input: { session: CodingSessionRecord; implementation: CodingAgentResult; evidence: Awaited<ReturnType<CodingSessionStore['evidenceForSession']>> }) => Promise<TestVerdict>;
  judge: (input: { session: CodingSessionRecord; implementation: CodingAgentResult; review: ReviewVerdict; test: TestVerdict; evidence: Awaited<ReturnType<CodingSessionStore['evidenceForSession']>> }) => Promise<JudgeVerdict>;
}

export interface CodingRunInput {
  goal: string;
  cwd: string;
  allowedTools?: string[];
  deniedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  requiredCapabilities?: string[];
}

export class CodingHarness {
  private readonly store: CodingSessionStore;
  private readonly hooks: HookEngine;
  private readonly adapter: CodingAgentAdapter;
  private readonly memory: MemoryStore | undefined;
  private readonly agents: AgentRegistry | undefined;
  private readonly reviewer: CodingHarnessOptions['reviewer'];
  private readonly tester: CodingHarnessOptions['tester'];
  private readonly judge: CodingHarnessOptions['judge'];

  constructor(options: CodingHarnessOptions) {
    this.store = options.store;
    this.hooks = options.hooks;
    this.adapter = options.adapter;
    this.memory = options.memory;
    this.agents = options.agents;
    this.reviewer = options.reviewer;
    this.tester = options.tester;
    this.judge = options.judge;
  }

  async run(input: CodingRunInput): Promise<CodingSessionRecord> {
    await this.store.init();
    const session = await this.store.createSession({ goal: input.goal, cwd: input.cwd, adapter: this.adapter.name });
    const start = await this.runHook('session-start', session, { goal: input.goal });
    if (start.action === 'block') return this.block(session.id, start.reason ?? 'session start blocked', true);
    return this.executeAttempt(session.id, input, false);
  }

  async resume(sessionId: string): Promise<CodingSessionRecord> {
    await this.store.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown coding session: ${sessionId}`);
    if (session.status === 'cancelled') throw new Error(`Coding session ${sessionId} is cancelled`);
    await this.store.updateSession(sessionId, { attempt: session.attempt + 1, status: 'running', finalVerdict: undefined, error: undefined });
    return this.executeAttempt(sessionId, { goal: session.goal, cwd: session.cwd }, true);
  }

  private async executeAttempt(sessionId: string, input: CodingRunInput, resumed: boolean): Promise<CodingSessionRecord> {
    await this.store.updateSession(sessionId, { status: 'running' });
    let session = (await this.store.getSession(sessionId))!;
    const preTask = await this.runHook('pre-task', session, { goal: input.goal, requiredCapabilities: input.requiredCapabilities ?? ['coding'], resumed });
    if (preTask.action === 'block') return this.block(sessionId, preTask.reason ?? 'pre-task blocked', true);

    const context: CodingAgentRequest['context'] = [];
    if (this.memory) {
      try {
        const hits = await this.memory.search({ query: input.goal, namespace: 'coding', subject: 'coding-harness', limit: 5 });
        for (const hit of hits) context.push({ kind: 'memory', content: hit.record.content });
      } catch (error) {
        await this.store.appendEvidence(sessionId, { type: 'failure', data: { stage: 'memory-recall', optional: true, error: error instanceof Error ? error.message : String(error) } });
      }
    }
    if (this.agents) {
      const recommended = this.agents.findByCapabilities(input.requiredCapabilities ?? ['coding']).slice(0, 5);
      if (recommended.length) context.push({ kind: 'agent-routing', content: recommended.map((agent) => `${agent.name}: ${agent.capabilities.join(',')}`).join('\n') });
    }

    if (!await this.adapter.available()) return this.fail(sessionId, `Coding adapter is unavailable: ${this.adapter.name}`, 'adapter-availability');
    const request: CodingAgentRequest = {
      sessionId,
      goal: input.goal,
      prompt: input.goal,
      cwd: input.cwd,
      allowedTools: [...(input.allowedTools ?? [])],
      deniedTools: [...(input.deniedTools ?? [])],
      maxTurns: input.maxTurns ?? 12,
      timeoutMs: input.timeoutMs ?? 120_000,
      context,
    };

    let implementation: CodingAgentResult;
    try { implementation = await this.adapter.run(request); }
    catch (error) { return this.fail(sessionId, error instanceof Error ? error.message : String(error), 'adapter-exception'); }
    await this.store.appendEvidence(sessionId, { type: 'adapter-output', data: structuredClone(implementation) as unknown as Record<string, unknown> });
    if (!implementation.success) return this.fail(sessionId, implementation.error ?? 'Coding adapter failed', 'adapter-result');

    for (const path of implementation.changedFiles) {
      await this.store.appendEvidence(sessionId, { type: 'file-change', data: { path, source: 'external-adapter-report', preAuthorizedByHelix: false } });
      await this.runHook('post-edit', session, { path, source: 'external-adapter-report', preAuthorizedByHelix: false });
    }
    for (const command of implementation.commands) {
      await this.store.appendEvidence(sessionId, { type: 'command', data: { ...command, source: 'external-adapter-report', preAuthorizedByHelix: false } });
      await this.runHook('post-command', session, { ...command, source: 'external-adapter-report', preAuthorizedByHelix: false });
    }

    const preReview = await this.runHook('pre-review', session, { adapter: implementation.adapter });
    if (preReview.action === 'block') return this.block(sessionId, preReview.reason ?? 'pre-review blocked', true);

    session = (await this.store.getSession(sessionId))!;
    const beforeReview = await this.store.evidenceForSession(sessionId);
    let review: ReviewVerdict;
    try { review = await this.reviewer({ session, implementation, evidence: beforeReview }); }
    catch (error) { return this.fail(sessionId, error instanceof Error ? error.message : String(error), 'reviewer'); }
    await this.store.appendEvidence(sessionId, { type: 'review', data: structuredClone(review) as unknown as Record<string, unknown> });

    let test: TestVerdict;
    try { test = await this.tester({ session, implementation, evidence: await this.store.evidenceForSession(sessionId) }); }
    catch (error) { return this.fail(sessionId, error instanceof Error ? error.message : String(error), 'tester'); }
    await this.store.appendEvidence(sessionId, { type: 'test', data: structuredClone(test) as unknown as Record<string, unknown> });

    let judge: JudgeVerdict;
    try { judge = await this.judge({ session, implementation, review, test, evidence: await this.store.evidenceForSession(sessionId) }); }
    catch (error) { return this.fail(sessionId, error instanceof Error ? error.message : String(error), 'judge'); }
    await this.store.appendEvidence(sessionId, { type: 'judge', data: structuredClone(judge) as unknown as Record<string, unknown> });

    const evidenceTypes = (await this.store.evidenceForSession(sessionId)).map((record) => record.type);
    const postReview = await this.runHook('post-review', session, { review, test, judge, evidenceTypes });
    const highFinding = review.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical');
    const testCommandsPassed = test.commands.every((command) => command.exitCode === 0);
    let accepted = review.approved && !highFinding && test.passed && testCommandsPassed && judge.accepted && judge.confidence >= 0.60 && postReview.action !== 'block';

    const postTask = await this.runHook('post-task', session, { success: accepted, review, test, judge });
    if (postTask.action === 'block') accepted = false;
    const final = await this.store.updateSession(sessionId, { status: accepted ? 'completed' : 'failed', finalVerdict: accepted ? 'accepted' : 'rejected', ...(accepted ? {} : { error: postReview.reason ?? postTask.reason ?? judge.reason }) });
    await this.learn(final, review, test, judge);
    await this.runHook('session-end', final, { status: final.status, verdict: final.finalVerdict });
    return (await this.store.getSession(sessionId))!;
  }

  private async runHook(event: HookEventName, session: CodingSessionRecord, payload: Record<string, unknown>): Promise<HookRunResult> {
    const result = await this.hooks.run({ event, sessionId: session.id, cwd: session.cwd, timestamp: new Date().toISOString(), payload, metadata: { attempt: session.attempt, adapter: session.adapter } });
    await this.store.appendEvidence(session.id, { type: 'hook', data: structuredClone(result) as unknown as Record<string, unknown> });
    return result;
  }

  private async block(sessionId: string, reason: string, end: boolean): Promise<CodingSessionRecord> {
    const session = await this.store.updateSession(sessionId, { status: 'blocked', finalVerdict: 'rejected', error: reason });
    await this.store.appendEvidence(sessionId, { type: 'failure', data: { stage: 'hook', blocked: true, reason } });
    if (end) await this.runHook('session-end', session, { status: 'blocked', reason });
    return (await this.store.getSession(sessionId))!;
  }

  private async fail(sessionId: string, reason: string, stage: string): Promise<CodingSessionRecord> {
    const session = await this.store.updateSession(sessionId, { status: 'failed', finalVerdict: 'rejected', error: reason });
    await this.store.appendEvidence(sessionId, { type: 'failure', data: { stage, reason } });
    await this.runHook('on-failure', session, { stage, reason });
    await this.runHook('session-end', session, { status: 'failed', reason });
    return (await this.store.getSession(sessionId))!;
  }

  private async learn(session: CodingSessionRecord, review: ReviewVerdict, test: TestVerdict, judge: JudgeVerdict): Promise<void> {
    if (!this.memory || typeof (this.memory as { store?: unknown }).store !== 'function') return;
    try {
      await this.memory.store({
        namespace: 'coding', owner: 'coding-harness', content: `Goal: ${session.goal}\nVerdict: ${session.finalVerdict}\nReview: ${review.summary}\nTests: ${test.summary}\nJudge: ${judge.reason}`,
        importance: session.finalVerdict === 'accepted' ? 0.7 : 0.85, confidence: Math.max(0, Math.min(1, judge.confidence)), source: {}, allowedSubjects: ['coding-harness'],
      });
    } catch { /* learning is non-critical */ }
  }
}
