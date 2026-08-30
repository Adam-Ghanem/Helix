import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableLearningEngine } from '../packages/learning/src/index.js';

function trajectory(executionId: string, strategy: string, success: boolean, quality: number) {
  return {
    executionId,
    steps: [{ taskType: 'coding', agentId: 'agent-1', strategy, latencyMs: 10, costUsd: 0.01, success }],
    evaluation: { success, quality, costUsd: 0.01, latencyMs: 10, reliability: success ? 1 : 0.2, toolEfficiency: 1, notes: [] },
  };
}

test('durable learning persists trajectories and recommendations across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-learning-'));
  try {
    const stateFile = join(directory, 'learning.json');
    const engine = new DurableLearningEngine({ stateFile, maxTrajectories: 10 });
    await engine.init();
    await engine.record(trajectory('ex-1', 'small-patches', true, 0.9));
    await engine.record(trajectory('ex-2', 'rewrite', false, 0.2));
    const first = await engine.recommend('coding');
    assert.equal(first[0]?.kind, 'successful-strategy');

    const restored = new DurableLearningEngine({ stateFile, maxTrajectories: 10 });
    await restored.init();
    assert.equal((await restored.trajectories()).length, 2);
    assert.equal((await restored.recommend('coding'))[0]?.key, first[0]?.key);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('explicit feedback changes ranking and distillation records success and failure guidance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-learning-feedback-'));
  try {
    const engine = new DurableLearningEngine({ stateFile: join(directory, 'learning.json') });
    await engine.init();
    await engine.record(trajectory('ex-1', 'strategy-a', true, 0.7));
    await engine.record(trajectory('ex-2', 'strategy-b', true, 0.7));
    const initial = await engine.recommend('coding');
    const preferred = initial.find((pattern) => pattern.key.includes('strategy-b'))!;
    await engine.feedback({ patternId: preferred.id, accepted: true, quality: 1, note: 'human preferred' });
    await engine.feedback({ patternId: initial.find((pattern) => pattern.key.includes('strategy-a'))!.id, accepted: false, quality: 0.1 });
    assert.equal((await engine.recommend('coding'))[0]?.id, preferred.id);

    await engine.record(trajectory('ex-3', 'dangerous-rewrite', false, 0.1));
    const distilled = await engine.distill('coding');
    assert.ok(distilled.preferredPatterns.length >= 1);
    assert.ok(distilled.avoidPatterns.some((key) => key.includes('dangerous-rewrite')));
    assert.ok(distilled.evidence.length >= 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('consolidation bounds trajectory history and prunes stale weak patterns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-learning-consolidate-'));
  try {
    const engine = new DurableLearningEngine({ stateFile: join(directory, 'learning.json'), maxTrajectories: 2, halfLifeDays: 1 });
    await engine.init();
    await engine.record(trajectory('ex-1', 'one', true, 0.8));
    await engine.record(trajectory('ex-2', 'two', true, 0.8));
    await engine.record(trajectory('ex-3', 'three', true, 0.8));
    const result = await engine.consolidate({ now: Date.now() + 365 * 86_400_000 });
    assert.equal((await engine.trajectories()).length, 2);
    assert.ok(result.prunedPatterns >= 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
