import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableFederationState,
  FederationHaHttpDispatcher,
  FederationHttpClient,
  FederationHttpServer,
  HighAvailabilityDistributedCoordinator,
  MemoryFederationHaStore,
} from '../packages/federation/src/index.js';

test('HA HTTP dispatcher verifies signed remote results without committing into legacy file state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-ha-http-'));
  const secret = 'ha-http-secret';
  let executions = 0;
  const workerState = new DurableFederationState({ stateFile: join(directory, 'worker.json'), localNodeId: 'worker-1', secret });
  const securityState = new DurableFederationState({ stateFile: join(directory, 'security.json'), localNodeId: 'coordinator-a', secret });
  const store = new MemoryFederationHaStore({ clusterId: 'ha-http' });
  await Promise.all([workerState.init(), securityState.init(), store.init()]);

  const server = new FederationHttpServer({
    nodeId: 'worker-1',
    secret,
    state: workerState,
    execute: async (task) => {
      executions += 1;
      return { success: true, output: { leaseId: task.leaseId, attempt: task.attempt } };
    },
  });
  const started = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const client = new FederationHttpClient({ nodeId: 'coordinator-a', secret, state: securityState, timeoutMs: 1_000 });
    const runtime = new HighAvailabilityDistributedCoordinator({
      coordinatorId: 'coordinator-a',
      store,
      client: new FederationHaHttpDispatcher(client),
      leaderTtlMs: 500,
      taskLeaseMs: 500,
      heartbeatTimeoutMs: 1_000,
      maxAttempts: 2,
    });
    await runtime.init();
    assert.equal((await runtime.campaign(1_000)).acquired, true);
    await runtime.heartbeatNode({ id: 'worker-1', endpoint: started.endpoint, capabilities: ['coding'], load: 0 }, 1_000);
    const task = await runtime.submit({ executionId: 'ha-http-exec', taskType: 'coding', goal: 'Execute remotely', requiredCapabilities: ['coding'], payload: {} }, 1_000);

    const result = await runtime.runTask(task.id, 1_010);
    assert.equal(result.success, true);
    assert.equal(result.attempt, 1);
    assert.equal(executions, 1);
    assert.equal((await store.getTask(task.id))?.status, 'completed');
    assert.equal((await store.findResultForTask(task.id))?.id, result.id);

    // The local DurableFederationState is only the signed-envelope replay/security store
    // for HA transport; it must not become a second authoritative task/result store.
    assert.equal(await securityState.getTask(task.id), undefined);
    assert.equal((await securityState.listResults()).length, 0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
