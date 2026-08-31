import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributedRuntimeCoordinator, DurableFederationState } from '../packages/federation/src/index.js';
import type { FederationResult, FederationTask } from '../packages/federation/src/index.js';

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

test('distributed coordinator takes over an expired lease on another healthy node', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-distributed-takeover-'));
  try {
    const state = new DurableFederationState({ stateFile: join(directory, 'state.json'), localNodeId: 'coordinator', secret: 'cluster-secret' });
    await state.init();
    const calls: Array<{ nodeId: string; attempt: number; leaseId: string }> = [];
    const dispatcher = {
      async dispatchTaskResult(input: { endpoint: string; task: FederationTask }): Promise<FederationResult> {
        const nodeId = input.task.assignedNodeId!;
        const leaseId = input.task.leaseId!;
        calls.push({ nodeId, attempt: input.task.attempt, leaseId });
        if (nodeId === 'node-a') throw new Error('ambiguous network failure');
        return {
          id: `result-${nodeId}-${input.task.attempt}`,
          taskId: input.task.id,
          executionId: input.task.executionId,
          nodeId,
          leaseId,
          attempt: input.task.attempt,
          success: true,
          output: { worker: nodeId },
          createdAt: new Date().toISOString(),
        };
      },
    };
    const coordinator = new DistributedRuntimeCoordinator({
      state,
      client: dispatcher,
      leaseMs: 1_000,
      heartbeatTimeoutMs: 1_500,
      maxAttempts: 3,
    });

    await coordinator.heartbeatNode({ id: 'node-a', endpoint: 'https://node-a.example', capabilities: ['coding'], load: 0 }, 1_000);
    await coordinator.heartbeatNode({ id: 'node-b', endpoint: 'https://node-b.example', capabilities: ['coding'], load: 5 }, 1_000);
    const task = await coordinator.submit({
      executionId: 'ex-takeover',
      taskType: 'coding',
      goal: 'Run remotely',
      requiredCapabilities: ['coding'],
      payload: {},
    });

    await assert.rejects(() => coordinator.runTask(task.id, 1_500), /ambiguous network failure/);
    assert.deepEqual(calls.map((call) => [call.nodeId, call.attempt]), [['node-a', 1]]);
    assert.equal((await state.getTask(task.id))?.status, 'running');
    assert.equal((await state.listLeases()).length, 1);

    await coordinator.heartbeatNode({ id: 'node-b', endpoint: 'https://node-b.example', capabilities: ['coding'], load: 1 }, 2_900);
    const recovery = await coordinator.recover(3_000);
    assert.equal(recovery.recoveredLeases.length, 1);
    assert.equal(recovery.results.length, 1);
    assert.equal(recovery.results[0]?.nodeId, 'node-b');
    assert.equal(recovery.results[0]?.attempt, 2);
    assert.deepEqual(calls.map((call) => [call.nodeId, call.attempt]), [['node-a', 1], ['node-b', 2]]);
    assert.equal((await state.getTask(task.id))?.status, 'completed');
    assert.equal((await state.listNodes()).find((node) => node.id === 'node-a')?.status, 'offline');
    assert.equal((await state.listResults()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('distributed coordinator refuses a new lease after max attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-distributed-attempts-'));
  try {
    const state = new DurableFederationState({ stateFile: join(directory, 'state.json'), localNodeId: 'coordinator', secret: 'cluster-secret' });
    await state.init();
    const coordinator = new DistributedRuntimeCoordinator({
      state,
      client: { async dispatchTaskResult() { throw new Error('worker disconnected'); } },
      leaseMs: 1_000,
      heartbeatTimeoutMs: 5_000,
      maxAttempts: 1,
    });
    await coordinator.heartbeatNode({ id: 'node-a', endpoint: 'https://node-a.example', capabilities: ['coding'], load: 0 }, 1_000);
    const task = await coordinator.submit({ executionId: 'ex-max', taskType: 'coding', goal: 'One attempt only', requiredCapabilities: ['coding'], payload: {} });

    await assert.rejects(() => coordinator.runTask(task.id, 1_100), /worker disconnected/);
    await coordinator.heartbeatNode({ id: 'node-a', endpoint: 'https://node-a.example', capabilities: ['coding'], load: 0 }, 2_200);
    await assert.rejects(() => coordinator.recover(2_201), /max attempts/i);
    assert.equal((await state.getTask(task.id))?.attempt, 1);
    assert.equal((await state.getTask(task.id))?.status, 'queued');
    assert.equal((await state.listLeases()).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable federation state migrates version 1 files without losing result attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-federation-v1-'));
  try {
    const stateFile = join(directory, 'state.json');
    const createdAt = '2026-08-30T10:00:00.000Z';
    await writeFile(stateFile, JSON.stringify({
      version: 1,
      nodes: [{ id: 'node-a', endpoint: 'https://node-a.example', capabilities: ['coding'], status: 'online', lastHeartbeat: createdAt, load: 1 }],
      tasks: [{
        id: 'task-v1', executionId: 'ex-v1', taskType: 'coding', goal: 'legacy state', requiredCapabilities: ['coding'], payload: {},
        assignedNodeId: 'node-a', status: 'completed', attempt: 2, createdAt, updatedAt: createdAt,
      }],
      results: [{ id: 'result-v1', taskId: 'task-v1', executionId: 'ex-v1', nodeId: 'node-a', success: true, output: { migrated: true }, createdAt }],
      seenMessages: [],
    }, null, 2));

    const state = new DurableFederationState({ stateFile, localNodeId: 'coordinator', secret: 'cluster-secret' });
    await state.init();
    assert.equal((await state.getTask('task-v1'))?.status, 'completed');
    assert.equal((await state.getResult('result-v1'))?.attempt, 2);
    assert.deepEqual((await state.getResult('result-v1'))?.output, { migrated: true });
    assert.equal((await state.listLeases()).length, 0);
    assert.equal((await state.listNodes())[0]?.id, 'node-a');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
