import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraph } from '../packages/planner/src/index.js';
import type { TaskRecord } from '../packages/core/src/index.js';

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'title' | 'status'>): TaskRecord {
  return {
    id: overrides.id,
    executionId: overrides.executionId ?? 'ex_replan',
    title: overrides.title,
    description: overrides.description ?? overrides.title,
    dependencies: overrides.dependencies ?? [],
    status: overrides.status,
    attempts: overrides.attempts ?? 0,
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  };
}

test('task graph atomically supersedes a failed task and rewires downstream work', () => {
  const intake = task({ id: 'task_intake', title: 'Interpret goal', status: 'completed', result: { kept: true } });
  const failed = task({ id: 'task_execute', title: 'Execute bounded work', status: 'failed', dependencies: [intake.id], attempts: 1, error: 'provider failure' });
  const downstream = task({ id: 'task_evaluate', title: 'Evaluate result', status: 'pending', dependencies: [failed.id] });
  const graph = new TaskGraph([intake, failed, downstream]);

  const revision = graph.supersedeFailed(failed.id, [
    { title: 'Repair execution', description: 'Recover the failed execution step.' },
    { title: 'Validate repair', description: 'Validate the repaired execution before continuing.' },
  ], 'ex_replan');

  assert.equal(graph.get(intake.id).status, 'completed');
  assert.deepEqual(graph.get(intake.id).result, { kept: true });
  assert.equal(graph.get(failed.id).status, 'skipped');
  assert.equal(graph.get(failed.id).error, 'provider failure');
  assert.equal(revision.replacements.length, 2);
  assert.deepEqual(revision.replacements[0]?.dependencies, [intake.id]);
  assert.deepEqual(revision.replacements[1]?.dependencies, [revision.replacements[0]!.id]);
  assert.deepEqual(graph.get(downstream.id).dependencies, [revision.replacements[1]!.id]);
  assert.equal(revision.replacements[0]?.status, 'ready');
  assert.equal(revision.replacements[1]?.status, 'pending');
});

test('task graph supersession rolls back when the target is not failed', () => {
  const ready = task({ id: 'task_ready', title: 'Ready work', status: 'ready' });
  const graph = new TaskGraph([ready]);
  const before = graph.all();
  assert.throws(() => graph.supersedeFailed(ready.id, [{ title: 'Repair', description: 'Should not apply.' }], 'ex_replan'), /failed/i);
  assert.deepEqual(graph.all(), before);
});
