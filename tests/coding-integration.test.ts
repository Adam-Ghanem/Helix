import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HookEngine } from '../packages/hooks/src/index.js';
import { CodingHarness, CodingSessionStore, DeterministicCodingAdapter } from '../packages/coding/src/index.js';

const reviewer = async () => ({ approved: true, findings: [], summary: 'ok' });
const tester = async () => ({ passed: true, commands: [], summary: 'ok' });
const judge = async () => ({ accepted: true, reason: 'ok', requiredFixes: [], confidence: 0.95 });

test('coding session survives restart and can be resumed with prior evidence intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-coding-integration-'));
  try {
    const stateFile = join(directory, 'coding.json');
    const firstStore = new CodingSessionStore({ stateFile });
    const first = new CodingHarness({ store: firstStore, hooks: new HookEngine(), adapter: new DeterministicCodingAdapter(), reviewer, tester, judge });
    const completed = await first.run({ goal: 'first pass', cwd: directory });
    const firstEvidence = await firstStore.evidenceForSession(completed.id);
    assert.ok(firstEvidence.length > 0);

    const restoredStore = new CodingSessionStore({ stateFile });
    const restored = new CodingHarness({ store: restoredStore, hooks: new HookEngine(), adapter: new DeterministicCodingAdapter(), reviewer, tester, judge });
    const resumed = await restored.resume(completed.id);
    assert.equal(resumed.attempt, 2);
    assert.ok((await restoredStore.evidenceForSession(completed.id)).length > firstEvidence.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('critical hook block is durable evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-coding-block-integration-'));
  try {
    const stateFile = join(directory, 'coding.json');
    const store = new CodingSessionStore({ stateFile });
    const hooks = new HookEngine();
    hooks.register({ id: 'deny', events: ['pre-task'], priority: 1, critical: true, timeoutMs: 100, handler: async () => ({ hookId: 'deny', action: 'block', reason: 'blocked by test' }) });
    const harness = new CodingHarness({ store, hooks, adapter: new DeterministicCodingAdapter(), reviewer, tester, judge });
    const blocked = await harness.run({ goal: 'blocked', cwd: directory });
    assert.equal(blocked.status, 'blocked');
    const restored = new CodingSessionStore({ stateFile });
    await restored.init();
    const evidence = await restored.evidenceForSession(blocked.id);
    assert.ok(evidence.some((record) => record.type === 'hook' && JSON.stringify(record.data).includes('blocked by test')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
