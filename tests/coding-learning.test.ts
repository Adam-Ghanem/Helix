import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodingHarness, CodingSessionStore, DeterministicCodingAdapter } from '../packages/coding/src/index.js';
import { HookEngine } from '../packages/hooks/src/index.js';

const reviewer = async () => ({ approved: true, findings: [], summary: 'review ok' });
const tester = async () => ({ passed: true, commands: [], summary: 'tests ok' });
const judge = async () => ({ accepted: true, reason: 'accepted', requiredFixes: [], confidence: 0.88 });

test('coding harness records terminal attempts as learning trajectories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-coding-learning-'));
  try {
    const store = new CodingSessionStore({ stateFile: join(directory, 'coding.json') });
    const trajectories: unknown[] = [];
    const harness = new CodingHarness({ store, hooks: new HookEngine(), adapter: new DeterministicCodingAdapter(), reviewer, tester, judge, learning: { record: async (trajectory) => { trajectories.push(trajectory); } } });
    const session = await harness.run({ goal: 'Implement parser', cwd: directory });
    assert.equal(session.status, 'completed');
    assert.equal(trajectories.length, 1);
    const trajectory = trajectories[0] as { executionId: string; steps: Array<{ taskType: string; strategy?: string; success: boolean }>; evaluation: { success: boolean; quality: number } };
    assert.equal(trajectory.executionId, session.id);
    assert.equal(trajectory.steps[0]?.taskType, 'coding');
    assert.equal(trajectory.steps[0]?.strategy, 'deterministic');
    assert.equal(trajectory.evaluation.success, true);
    assert.ok(trajectory.evaluation.quality >= 0.8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('learning sink failures are non-critical and become optional failure evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-coding-learning-fail-'));
  try {
    const store = new CodingSessionStore({ stateFile: join(directory, 'coding.json') });
    const harness = new CodingHarness({ store, hooks: new HookEngine(), adapter: new DeterministicCodingAdapter(), reviewer, tester, judge, learning: { record: async () => { throw new Error('learning offline'); } } });
    const session = await harness.run({ goal: 'Keep success', cwd: directory });
    assert.equal(session.status, 'completed');
    const evidence = await store.evidenceForSession(session.id);
    assert.ok(evidence.some((record) => record.type === 'failure' && record.data.stage === 'learning' && record.data.optional === true));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
