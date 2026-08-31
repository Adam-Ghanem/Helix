import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributedRuntimeCoordinator, DurableFederationState } from '../packages/federation/src/index.js';
import type { FederationResult, FederationTask } from '../packages/federation/src/index.js';

test('distributed coordinator owns fenced result commit through a result-only dispatcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-dispatcher-contract-'));
  try {
    const state = new DurableFederationState({
      stateFile: join(directory, 'state.json'),
      localNodeId: 'coordinator',
      secret: 'cluster-secret',
    });
    await state.init();

    const dispatcher = {
      async dispatchTaskResult(input: { endpoint: string; task: FederationTask }): Promise<FederationResult> {
        return {
          id: 'result-only-dispatch',
          taskId: input.task.id,
          executionId: input.task.executionId,
          nodeId: input.task.assignedNodeId!,
          leaseId: input.task.leaseId!,
          attempt: input.task.attempt,
          success: true,
          output: { authoritativeCommit: 'coordinator' },
          createdAt: new Date(1_100).toISOString(),
        };
      },
    };

    const coordinator = new DistributedRuntimeCoordinator({
      state,
      client: dispatcher,
      leaseMs: 1_000,
      heartbeatTimeoutMs: 5_000,
      maxAttempts: 2,
    });
    await coordinator.heartbeatNode({
      id: 'worker-1',
      endpoint: 'https://worker-1.example',
      capabilities: ['coding'],
      load: 0,
    }, 1_000);
    const task = await coordinator.submit({
      executionId: 'ex-result-only',
      taskType: 'coding',
      goal: 'Commit at coordinator',
      requiredCapabilities: ['coding'],
      payload: {},
    });

    const result = await coordinator.runTask(task.id, 1_100);
    assert.equal(result.id, 'result-only-dispatch');
    assert.equal((await state.getTask(task.id))?.status, 'completed');
    assert.equal((await state.listLeases()).length, 0);
    assert.equal((await state.listResults()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
