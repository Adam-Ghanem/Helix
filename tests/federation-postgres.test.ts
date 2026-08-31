import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresFederationStore } from '../packages/federation/src/index.js';

const connectionString = process.env.HELIX_TEST_POSTGRES_URL;

function integration(name: string, fn: () => Promise<void>): void {
  test(name, { skip: connectionString ? false : 'HELIX_TEST_POSTGRES_URL is not configured' }, fn);
}

integration('PostgreSQL HA store coordinates leadership, takeover and fenced task result commit', async () => {
  const clusterId = `helix-test-${randomUUID()}`;
  const a = new PostgresFederationStore({ connectionString: connectionString!, clusterId });
  const b = new PostgresFederationStore({ connectionString: connectionString!, clusterId });
  await Promise.all([a.init(), b.init()]);
  try {
    const first = await a.acquireLeadership('coordinator-a', { ttlMs: 100, now: 1_000 });
    assert.equal(first.acquired, true);
    assert.equal(first.lease?.term, 1);

    const standby = await b.acquireLeadership('coordinator-b', { ttlMs: 100, now: 1_050 });
    assert.equal(standby.acquired, false);
    assert.equal(standby.lease?.leaderId, 'coordinator-a');

    await a.heartbeatNode({ id: 'worker-a', endpoint: 'https://worker-a.example', capabilities: ['coding'], load: 0 }, 1_000);
    const task = await a.submitTask(first.lease!, {
      executionId: 'exec-postgres',
      taskType: 'coding',
      goal: 'Verify shared HA state',
      requiredCapabilities: ['coding'],
      payload: { shared: true },
    }, 1_000);

    const claimA = await a.claimTask(first.lease!, task.id, 'worker-a', { leaseMs: 40, now: 1_000 });
    assert.equal(claimA.task.attempt, 1);
    assert.equal((await b.getTask(task.id))?.leaseId, claimA.leaseId);

    const second = await b.acquireLeadership('coordinator-b', { ttlMs: 100, now: 1_101 });
    assert.equal(second.acquired, true);
    assert.equal(second.lease?.term, 2);
    await assert.rejects(() => a.assertLeadership(first.lease!, 1_101), /stale leader/i);

    const recovered = await b.recoverExpiredTaskLeases(second.lease!, 1_101);
    assert.equal(recovered.length, 1);
    const claimB = await b.claimTask(second.lease!, task.id, 'worker-a', { leaseMs: 100, now: 1_101 });
    assert.equal(claimB.task.attempt, 2);

    await assert.rejects(
      () => a.commitResult(first.lease!, {
        id: `result-${randomUUID()}`,
        taskId: task.id,
        executionId: task.executionId,
        nodeId: 'worker-a',
        leaseId: claimA.leaseId,
        attempt: 1,
        success: true,
        output: { stale: true },
        createdAt: new Date(1_101).toISOString(),
      }, 1_101),
      /stale leader/i,
    );

    const result = await b.commitResult(second.lease!, {
      id: `result-${randomUUID()}`,
      taskId: task.id,
      executionId: task.executionId,
      nodeId: 'worker-a',
      leaseId: claimB.leaseId,
      attempt: 2,
      success: true,
      output: { owner: 'coordinator-b' },
      createdAt: new Date(1_102).toISOString(),
    }, 1_102);
    assert.equal(result.success, true);
    assert.equal((await a.getTask(task.id))?.status, 'completed');
    assert.equal((await a.findResultForTask(task.id))?.attempt, 2);
    assert.equal((await b.findResultForTask(task.id))?.id, result.id);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

integration('PostgreSQL HA store serializes concurrent leadership campaigns', async () => {
  const clusterId = `helix-race-${randomUUID()}`;
  const a = new PostgresFederationStore({ connectionString: connectionString!, clusterId });
  const b = new PostgresFederationStore({ connectionString: connectionString!, clusterId });
  await Promise.all([a.init(), b.init()]);
  try {
    const [left, right] = await Promise.all([
      a.acquireLeadership('a', { ttlMs: 1_000, now: 5_000 }),
      b.acquireLeadership('b', { ttlMs: 1_000, now: 5_000 }),
    ]);
    assert.equal(Number(left.acquired) + Number(right.acquired), 1);
    assert.equal(left.lease?.term, 1);
    assert.equal(right.lease?.term, 1);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
