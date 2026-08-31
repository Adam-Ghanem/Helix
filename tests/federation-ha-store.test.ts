import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFederationHaStore } from '../packages/federation/src/index.js';

test('memory HA store fences leaders across takeover and claims tasks once', async () => {
  const store = new MemoryFederationHaStore({ clusterId: 'cluster-a' });
  await store.init();

  const first = await store.acquireLeadership('coordinator-a', { ttlMs: 100, now: 1_000 });
  assert.equal(first.acquired, true);
  assert.equal(first.lease?.term, 1);

  const standby = await store.acquireLeadership('coordinator-b', { ttlMs: 100, now: 1_050 });
  assert.equal(standby.acquired, false);
  assert.equal(standby.lease?.leaderId, 'coordinator-a');

  const second = await store.acquireLeadership('coordinator-b', { ttlMs: 100, now: 1_101 });
  assert.equal(second.acquired, true);
  assert.equal(second.lease?.term, 2);
  assert.notEqual(second.lease?.fencingToken, first.lease?.fencingToken);

  await assert.rejects(() => store.assertLeadership(first.lease!, 1_101), /stale leader/i);
  await store.assertLeadership(second.lease!, 1_101);

  await store.heartbeatNode({ id: 'worker-1', endpoint: 'https://worker-1.example', capabilities: ['coding'], load: 0 }, 1_101);
  const task = await store.submitTask(second.lease!, {
    executionId: 'exec-1',
    taskType: 'coding',
    goal: 'Implement HA',
    requiredCapabilities: ['coding'],
    payload: { branch: 'feat/ha' },
  }, 1_101);

  const claim = await store.claimTask(second.lease!, task.id, 'worker-1', { leaseMs: 50, now: 1_101 });
  assert.equal(claim.task.attempt, 1);
  assert.equal(claim.task.status, 'running');
  assert.equal(claim.task.assignedNodeId, 'worker-1');
  assert.equal(claim.leaderTerm, 2);
  assert.ok(claim.leaseId);

  await assert.rejects(
    () => store.claimTask(second.lease!, task.id, 'worker-1', { leaseMs: 50, now: 1_102 }),
    /cannot be claimed|already leased/i,
  );
});

test('memory HA store rejects stale leader result commits after takeover', async () => {
  const store = new MemoryFederationHaStore({ clusterId: 'cluster-b' });
  await store.init();
  const a = (await store.acquireLeadership('a', { ttlMs: 20, now: 1_000 })).lease!;
  await store.heartbeatNode({ id: 'worker', endpoint: 'https://worker.example', capabilities: ['coding'], load: 0 }, 1_000);
  const task = await store.submitTask(a, {
    executionId: 'exec-2', taskType: 'coding', goal: 'Fence stale leader', requiredCapabilities: ['coding'], payload: {},
  }, 1_000);
  const claim = await store.claimTask(a, task.id, 'worker', { leaseMs: 100, now: 1_000 });

  const b = (await store.acquireLeadership('b', { ttlMs: 50, now: 1_021 })).lease!;
  assert.equal(b.term, 2);
  await assert.rejects(
    () => store.commitResult(a, {
      id: 'result-stale',
      taskId: task.id,
      executionId: task.executionId,
      nodeId: 'worker',
      leaseId: claim.leaseId,
      attempt: 1,
      success: true,
      output: { stale: true },
      createdAt: new Date(1_021).toISOString(),
    }, 1_021),
    /stale leader/i,
  );
});

test('memory HA store requires the current leader to expire stale nodes', async () => {
  const store = new MemoryFederationHaStore({ clusterId: 'cluster-node-expiry' });
  await store.init();
  const a = (await store.acquireLeadership('a', { ttlMs: 20, now: 1_000 })).lease!;
  await store.heartbeatNode({ id: 'worker', endpoint: 'https://worker.example', capabilities: ['coding'], load: 0 }, 1_000);
  const b = (await store.acquireLeadership('b', { ttlMs: 100, now: 1_021 })).lease!;

  await assert.rejects(() => store.expireStaleNodes(a, 10, 1_021), /stale leader/i);
  assert.equal((await store.listNodes())[0]?.status, 'online');

  const expired = await store.expireStaleNodes(b, 10, 1_021);
  assert.equal(expired.length, 1);
  assert.equal((await store.listNodes())[0]?.status, 'offline');
});
