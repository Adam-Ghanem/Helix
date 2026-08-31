import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributedRuntimeCoordinator, DurableFederationState, FederationHttpClient, FederationHttpServer } from '../packages/federation/src/index.js';

test('distributed coordinator renews the authoritative lease during a long HTTP dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-distributed-http-renewal-'));
  const secret = 'cluster-secret';
  let executions = 0;
  const workerState = new DurableFederationState({ stateFile: join(directory, 'worker.json'), localNodeId: 'worker-1', secret });
  await workerState.init();
  const server = new FederationHttpServer({
    nodeId: 'worker-1',
    secret,
    state: workerState,
    execute: async () => {
      executions += 1;
      // Keep execution well beyond one lease while leaving enough scheduling
      // headroom for heavily contended CI runners. Without renewal this still expires.
      await new Promise((resolve) => setTimeout(resolve, 360));
      return { success: true, output: { longRunning: true } };
    },
  });
  const started = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const originState = new DurableFederationState({ stateFile: join(directory, 'origin.json'), localNodeId: 'coordinator', secret });
    await originState.init();
    const client = new FederationHttpClient({ nodeId: 'coordinator', secret, state: originState, timeoutMs: 1_000 });
    const coordinator = new DistributedRuntimeCoordinator({
      state: originState,
      client,
      leaseMs: 120,
      heartbeatTimeoutMs: 1_000,
      maxAttempts: 2,
    });
    await coordinator.heartbeatNode({ id: 'worker-1', endpoint: started.endpoint, capabilities: ['coding'], load: 0 });
    const task = await coordinator.submit({ executionId: 'ex-long-http', taskType: 'coding', goal: 'Long remote execution', requiredCapabilities: ['coding'], payload: {} });

    const result = await coordinator.runTask(task.id);
    assert.equal(result.success, true);
    assert.equal(result.attempt, 1);
    assert.ok(result.leaseId);
    assert.equal(executions, 1);
    assert.equal((await originState.getTask(task.id))?.status, 'completed');
    assert.equal((await originState.listLeases()).length, 0);
    assert.equal((await originState.listResults()).length, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
