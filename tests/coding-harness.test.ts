import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HookEngine } from '../packages/hooks/src/index.js';
import { CodingAgentAdapter, CodingHarness, CodingSessionStore, DeterministicCodingAdapter } from '../packages/coding/src/index.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'helix-harness-'));
  const store = new CodingSessionStore({ stateFile: join(directory, 'coding.json') });
  await store.init();
  return { directory, store };
}

const approvedReview = async () => ({ approved: true, findings: [], summary: 'review ok' as const });
const passedTests = async () => ({ passed: true, commands: [{ command: 'pnpm test', exitCode: 0, durationMs: 1 }], summary: 'tests ok' as const });
const acceptedJudge = async () => ({ accepted: true, reason: 'evidence satisfied', requiredFixes: [], confidence: 0.9 });

test('coding harness persists accepted workflow evidence and lifecycle hooks', async () => {
  const { directory, store } = await setup();
  try {
    const hooks = new HookEngine();
    const events: string[] = [];
    for (const event of ['session-start', 'pre-task', 'post-edit', 'post-command', 'pre-review', 'post-review', 'post-task', 'session-end'] as const) {
      hooks.register({ id: `audit-${event}`, events: [event], priority: 100, critical: false, timeoutMs: 100, alwaysRun: true, handler: async (ctx) => { events.push(ctx.event); return { hookId: `audit-${event}`, action: 'continue' }; } });
    }
    const adapter: CodingAgentAdapter = { name: 'fixture', available: async () => true, run: async () => ({ adapter: 'fixture', success: true, output: 'implemented', changedFiles: ['src/a.ts'], commands: [{ command: 'pnpm test', exitCode: 0 }] }) };
    const harness = new CodingHarness({ store, hooks, adapter, reviewer: approvedReview, tester: passedTests, judge: acceptedJudge });
    const session = await harness.run({ goal: 'Implement feature', cwd: directory });
    assert.equal(session.status, 'completed');
    assert.equal(session.finalVerdict, 'accepted');
    assert.deepEqual(events, ['session-start', 'pre-task', 'post-edit', 'post-command', 'pre-review', 'post-review', 'post-task', 'session-end']);
    const types = (await store.evidenceForSession(session.id)).map((record) => record.type);
    for (const required of ['adapter-output', 'file-change', 'command', 'review', 'test', 'judge']) assert.ok(types.includes(required as never));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pre-task block stops adapter execution and persists blocked session', async () => {
  const { directory, store } = await setup();
  try {
    const hooks = new HookEngine();
    hooks.register({ id: 'policy-block', events: ['pre-task'], priority: 1, critical: true, timeoutMs: 100, handler: async () => ({ hookId: 'policy-block', action: 'block', reason: 'policy denied' }) });
    let ran = false;
    const adapter: CodingAgentAdapter = { name: 'never', available: async () => true, run: async () => { ran = true; return { adapter: 'never', success: true, output: '', changedFiles: [], commands: [] }; } };
    const harness = new CodingHarness({ store, hooks, adapter, reviewer: approvedReview, tester: passedTests, judge: acceptedJudge });
    const session = await harness.run({ goal: 'blocked', cwd: directory });
    assert.equal(ran, false);
    assert.equal(session.status, 'blocked');
    assert.equal(session.finalVerdict, 'rejected');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('adapter failure fires on-failure and durable resume increments attempt', async () => {
  const { directory, store } = await setup();
  try {
    const hooks = new HookEngine();
    let failures = 0;
    hooks.register({ id: 'failure-audit', events: ['on-failure'], priority: 1, critical: false, timeoutMs: 100, alwaysRun: true, handler: async () => { failures += 1; return { hookId: 'failure-audit', action: 'continue' }; } });
    let calls = 0;
    const adapter: CodingAgentAdapter = { name: 'flaky', available: async () => true, run: async () => { calls += 1; return calls === 1 ? { adapter: 'flaky', success: false, output: '', changedFiles: [], commands: [], error: 'boom' } : { adapter: 'flaky', success: true, output: 'fixed', changedFiles: [], commands: [] }; } };
    const harness = new CodingHarness({ store, hooks, adapter, reviewer: approvedReview, tester: passedTests, judge: acceptedJudge });
    const failed = await harness.run({ goal: 'retry me', cwd: directory });
    assert.equal(failed.status, 'failed');
    assert.equal(failures, 1);
    const resumed = await harness.resume(failed.id);
    assert.equal(resumed.attempt, 2);
    assert.equal(resumed.status, 'completed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('quality gates reject failed tests, high findings, and low-confidence judges', async () => {
  const cases = [
    { reviewer: approvedReview, tester: async () => ({ passed: false, commands: [{ command: 'pnpm test', exitCode: 1, durationMs: 1 }], summary: 'failed' }), judge: acceptedJudge },
    { reviewer: async () => ({ approved: false, findings: [{ severity: 'high' as const, message: 'bug' }], summary: 'bad' }), tester: passedTests, judge: acceptedJudge },
    { reviewer: approvedReview, tester: passedTests, judge: async () => ({ accepted: true, reason: 'uncertain', requiredFixes: [], confidence: 0.59 }) },
  ];
  for (const [index, candidate] of cases.entries()) {
    const { directory, store } = await setup();
    try {
      const harness = new CodingHarness({ store, hooks: new HookEngine(), adapter: new DeterministicCodingAdapter(), ...candidate });
      const session = await harness.run({ goal: `case-${index}`, cwd: directory });
      assert.equal(session.finalVerdict, 'rejected');
      assert.equal(session.status, 'failed');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('memory hits are injected into adapter context', async () => {
  const { directory, store } = await setup();
  try {
    let contextContent = '';
    const adapter: CodingAgentAdapter = { name: 'capture', available: async () => true, run: async (request) => { contextContent = request.context.map((item) => item.content).join('\n'); return { adapter: 'capture', success: true, output: 'ok', changedFiles: [], commands: [] }; } };
    const memory = { search: async () => [{ record: { content: 'previous parser failure' }, score: 1 }] };
    const harness = new CodingHarness({ store, hooks: new HookEngine(), adapter, reviewer: approvedReview, tester: passedTests, judge: acceptedJudge, memory: memory as never });
    await harness.run({ goal: 'parser', cwd: directory });
    assert.match(contextContent, /previous parser failure/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
