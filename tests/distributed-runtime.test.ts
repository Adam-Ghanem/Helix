import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableFederationState } from '../packages/federation/src/index.js';

test('durable federation leases fence stale attempts across takeover and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-distributed-lease-'));
  try {
    const stateFile = join(directory, 'state.json');
    const state = new DurableFederationState({ stateFile, localNodeId: 'coordinator', secret: 'cluster-secret' });
    await state.init();
    const task = await state.enqueueTask({
      executionId: 'ex-distributed',
      taskType: 'coding',
      goal: 'Implement distributed execution',
      requiredCapabilities: ['coding'],
      payload: {},
    });

    const first = await state.acquireLease(task.id, 'node-a', { leaseMs: 1_000, now: 1_000 });
    assert.equal(first.attempt, 1);
    assert.equal(first.nodeId, 'node-a');
    assert.equal((await state.getTask(task.id))?.status, 'running');
    assert.equal((await state.getTask(task.id))?.leaseId, first.id);
    await assert.rejects(() => state.acquireLease(task.id, 'node-b', { leaseMs: 1_000, now: 1_500 }), /leased|running/i);

    const recovered = await state.recoverExpiredLeases(2_001);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.id, first.id);
    assert.equal((await state.getTask(task.id))?.status, 'queued');
    assert.equal((await state.getTask(task.id))?.assignedNodeId, undefined);

    const second = await state.acquireLease(task.id, 'node-b', { leaseMs: 1_000, now: 2_100 });
    assert.equal(second.attempt, 2);
    assert.equal(second.nodeId, 'node-b');

    await assert.rejects(() => state.commitLeasedResult({
      id: 'fedr-stale',
      taskId: task.id,
      executionId: task.executionId,
      nodeId: 'node-a',
      leaseId: first.id,
      attempt: 1,
      success: true,
      output: { stale: true },
      createdAt: new Date(2_150).toISOString(),
    }, 2_150), /stale|lease|attempt/i);
    assert.equal((await state.listResults()).length, 0);

    const committed = await state.commitLeasedResult({
      id: 'fedr-current',
      taskId: task.id,
      executionId: task.executionId,
      nodeId: 'node-b',
      leaseId: second.id,
      attempt: 2,
      success: true,
      output: { ok: true },
      createdAt: new Date(2_200).toISOString(),
    }, 2_200);
    assert.equal(committed.id, 'fedr-current');
    assert.equal((await state.getTask(task.id))?.status, 'completed');
    assert.equal((await state.listLeases()).length, 0);

    const restored = new DurableFederationState({ stateFile, localNodeId: 'coordinator', secret: 'cluster-secret' });
    await restored.init();
    assert.equal((await restored.getTask(task.id))?.status, 'completed');
    assert.equal((await restored.getResult(committed.id))?.attempt, 2);
    assert.equal((await restored.listLeases()).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
