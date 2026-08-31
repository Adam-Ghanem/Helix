import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HighAvailabilityDistributedCoordinator,
  MemoryFederationHaStore,
  type FederationResult,
  type FederationTaskDispatcher,
} from '../packages/federation/src/index.js';

class SequencedDispatcher implements FederationTaskDispatcher {
  readonly attempts: Array<{ taskId: string; attempt: number; nodeId?: string }> = [];
  private failures: number;

  constructor(failures = 0) {
    this.failures = failures;
  }

  async dispatchTask({ task }: Parameters<FederationTaskDispatcher['dispatchTask']>[0]): Promise<FederationResult> {
    this.attempts.push({ taskId: task.id, attempt: task.attempt, ...(task.assignedNodeId ? { nodeId: task.assignedNodeId } : {}) });
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('ambiguous transport failure');
    }
    if (!task.assignedNodeId || !task.leaseId) throw new Error('HA dispatcher requires a leased task');
    return {
      id: `result-${task.id}-${task.attempt}`,
      taskId: task.id,
      executionId: task.executionId,
      nodeId: task.assignedNodeId,
      leaseId: task.leaseId,
      attempt: task.attempt,
      success: true,
      output: { attempt: task.attempt },
      createdAt: new Date(1_200 + task.attempt).toISOString(),
    };
  }
}

function coordinator(
  coordinatorId: string,
  store: MemoryFederationHaStore,
  client: FederationTaskDispatcher,
): HighAvailabilityDistributedCoordinator {
  return new HighAvailabilityDistributedCoordinator({
    coordinatorId,
    store,
    client,
    leaderTtlMs: 100,
    taskLeaseMs: 40,
    heartbeatTimeoutMs: 500,
    maxAttempts: 3,
  });
}

test('HA coordinator allows only the current leader to submit and dispatch', async () => {
  const store = new MemoryFederationHaStore({ clusterId: 'runtime-leader' });
  const dispatcher = new SequencedDispatcher();
  const a = coordinator('coordinator-a', store, dispatcher);
  const b = coordinator('coordinator-b', store, dispatcher);
  await Promise.all([a.init(), b.init()]);

  const aCampaign = await a.campaign(1_000);
  assert.equal(aCampaign.acquired, true);
  assert.equal(a.leadership()?.term, 1);
  const bCampaign = await b.campaign(1_010);
  assert.equal(bCampaign.acquired, false);
  assert.equal(b.leadership(), undefined);

  await a.heartbeatNode({ id: 'worker-1', endpoint: 'https://worker.example', capabilities: ['coding'], load: 0 }, 1_000);
  const task = await a.submit({ executionId: 'exec-1', taskType: 'coding', goal: 'Run once', requiredCapabilities: ['coding'], payload: {} }, 1_000);

  await assert.rejects(() => b.runTask(task.id, 1_010), /not leader|leadership/i);
  const result = await a.runTask(task.id, 1_020);
  assert.equal(result.success, true);
  assert.equal(result.attempt, 1);
  assert.equal(dispatcher.attempts.length, 1);
  assert.equal((await store.getTask(task.id))?.status, 'completed');
});

test('HA coordinator recovers an ambiguous task after leader takeover without accepting the stale leader', async () => {
  const store = new MemoryFederationHaStore({ clusterId: 'runtime-takeover' });
  const dispatcher = new SequencedDispatcher(1);
  const a = coordinator('coordinator-a', store, dispatcher);
  const b = coordinator('coordinator-b', store, dispatcher);
  await Promise.all([a.init(), b.init()]);

  assert.equal((await a.campaign(1_000)).acquired, true);
  const staleLeader = a.leadership()!;
  await a.heartbeatNode({ id: 'worker-1', endpoint: 'https://worker.example', capabilities: ['coding'], load: 0 }, 1_000);
  const task = await a.submit({ executionId: 'exec-2', taskType: 'coding', goal: 'Survive takeover', requiredCapabilities: ['coding'], payload: {} }, 1_000);

  await assert.rejects(() => a.runTask(task.id, 1_000), /ambiguous transport failure/);
  const abandoned = await store.getTask(task.id);
  assert.equal(abandoned?.status, 'running');
  assert.equal(abandoned?.attempt, 1);
  assert.ok(abandoned?.leaseId);

  const takeover = await b.campaign(1_101);
  assert.equal(takeover.acquired, true);
  assert.equal(b.leadership()?.term, 2);
  assert.notEqual(b.leadership()?.fencingToken, staleLeader.fencingToken);

  await assert.rejects(() => store.assertLeadership(staleLeader, 1_101), /stale leader/i);
  const recovery = await b.recover(1_101);
  assert.equal(recovery.recoveredTasks.length, 1);
  assert.equal(recovery.results.length, 1);
  assert.equal(recovery.results[0]?.attempt, 2);
  assert.equal(dispatcher.attempts.length, 2);
  assert.deepEqual(dispatcher.attempts.map((entry) => entry.attempt), [1, 2]);
  assert.equal((await store.getTask(task.id))?.status, 'completed');
});

test('HA coordinator enforces max attempts after repeated expired leases', async () => {
  const store = new MemoryFederationHaStore({ clusterId: 'runtime-attempts' });
  const dispatcher = new SequencedDispatcher(5);
  const runtime = new HighAvailabilityDistributedCoordinator({
    coordinatorId: 'coordinator-a',
    store,
    client: dispatcher,
    leaderTtlMs: 1_000,
    taskLeaseMs: 20,
    heartbeatTimeoutMs: 1_000,
    maxAttempts: 2,
  });
  await runtime.init();
  await runtime.campaign(1_000);
  await runtime.heartbeatNode({ id: 'worker', endpoint: 'https://worker.example', capabilities: ['coding'], load: 0 }, 1_000);
  const task = await runtime.submit({ executionId: 'exec-3', taskType: 'coding', goal: 'Bound retries', requiredCapabilities: ['coding'], payload: {} }, 1_000);

  await assert.rejects(() => runtime.runTask(task.id, 1_000), /ambiguous transport failure/);
  await runtime.recover(1_021).catch(() => undefined);
  assert.equal((await store.getTask(task.id))?.attempt, 2);
  await store.recoverExpiredTaskLeases(runtime.leadership()!, 1_050);
  await assert.rejects(() => runtime.runTask(task.id, 1_050), /max attempts/i);
});
