import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HookEngine } from '../packages/hooks/src/index.js';
import { createCommandSafetyHook, createEditContextHook, createOutcomeLearningHook, createQualityGateHook, createTaskPreparationHook } from '../packages/coding/src/index.js';

function ctx(event: 'pre-task' | 'pre-edit' | 'pre-command' | 'post-review' | 'post-task', cwd: string, payload: Record<string, unknown> = {}) {
  return { event, sessionId: 's1', cwd, timestamp: new Date().toISOString(), payload, metadata: {} } as const;
}

test('task preparation enriches context without blocking when memory is unavailable', async () => {
  const engine = new HookEngine();
  engine.register(createTaskPreparationHook({ memory: { search: async () => { throw new Error('offline'); } } as never, agents: { findByCapabilities: () => [{ name: 'coder' }] } as never }));
  const result = await engine.run(ctx('pre-task', process.cwd(), { requiredCapabilities: ['coding'] }));
  assert.equal(result.action, 'continue');
  assert.ok(Array.isArray(result.annotations.recommendedAgents));
});

test('edit and command safety hooks fail closed on workspace escape and denied command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-builtins-'));
  try {
    const editEngine = new HookEngine();
    editEngine.register(createEditContextHook({ workspaceRoots: [directory] }));
    const edit = await editEngine.run(ctx('pre-edit', directory, { path: join(tmpdir(), 'escape.ts') }));
    assert.equal(edit.action, 'block');

    const commandEngine = new HookEngine();
    commandEngine.register(createCommandSafetyHook({ deniedPatterns: [/rm\s+-rf/i] }));
    const command = await commandEngine.run(ctx('pre-command', directory, { command: 'rm -rf /' }));
    assert.equal(command.action, 'block');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('quality gate and outcome learning hooks enforce evidence and record outcomes', async () => {
  const quality = new HookEngine();
  quality.register(createQualityGateHook());
  const blocked = await quality.run(ctx('post-review', process.cwd(), { review: { approved: true, findings: [] }, test: { passed: true }, judge: { accepted: true, confidence: 0.9 }, evidenceTypes: ['review', 'test'] }));
  assert.equal(blocked.action, 'block');

  let learned = 0;
  const learning = new HookEngine();
  learning.register(createOutcomeLearningHook({ record: async () => { learned += 1; } }));
  const result = await learning.run(ctx('post-task', process.cwd(), { success: true }));
  assert.equal(result.action, 'continue');
  assert.equal(learned, 1);
});
