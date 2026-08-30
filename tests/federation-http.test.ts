import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableFederationState, FederationHttpClient, FederationHttpServer } from '../packages/federation/src/index.js';

test('federation http plane dispatches signed tasks and persists remote results idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-fed-http-'));
  const secret = 'cluster-secret';
  let calls = 0;
  const nodeB = new DurableFederationState({ stateFile: join(directory, 'node-b.json'), localNodeId: 'node-b', secret });
  await nodeB.init();
  const server = new FederationHttpServer({
    nodeId: 'node-b',
    secret,
    state: nodeB,
    execute: async (task) => {
      calls += 1;
      return { success: true, output: { goal: task.goal, worker: 'node-b' } };
    },
  });
  const started = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const nodeA = new DurableFederationState({ stateFile: join(directory, 'node-a.json'), localNodeId: 'node-a', secret });
    await nodeA.init();
    const task = await nodeA.enqueueTask({ executionId: 'ex-http', taskType: 'coding', goal: 'Implement federation', requiredCapabilities: ['coding'], payload: {}, assignedNodeId: 'node-b' });
    const client = new FederationHttpClient({ nodeId: 'node-a', secret, state: nodeA, timeoutMs: 2_000 });

    const first = await client.dispatchTask({ endpoint: started.endpoint, task });
    assert.equal(first.success, true);
    assert.deepEqual(first.output, { goal: 'Implement federation', worker: 'node-b' });
    assert.equal(calls, 1);
    assert.equal((await nodeB.getTask(task.id))?.status, 'completed');
    assert.equal((await nodeA.getTask(task.id))?.status, 'completed');
    assert.equal((await nodeA.getResult(first.id))?.nodeId, 'node-b');

    const second = await client.dispatchTask({ endpoint: started.endpoint, task });
    assert.equal(second.id, first.id);
    assert.equal(calls, 1);
    assert.equal((await nodeB.listResults()).length, 1);
    assert.equal((await nodeA.listResults()).length, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('federation http plane rejects messages signed with the wrong secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-fed-http-auth-'));
  const nodeB = new DurableFederationState({ stateFile: join(directory, 'node-b.json'), localNodeId: 'node-b', secret: 'right-secret' });
  await nodeB.init();
  const server = new FederationHttpServer({ nodeId: 'node-b', secret: 'right-secret', state: nodeB, execute: async () => ({ success: true }) });
  const started = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const nodeA = new DurableFederationState({ stateFile: join(directory, 'node-a.json'), localNodeId: 'node-a', secret: 'wrong-secret' });
    await nodeA.init();
    const task = await nodeA.enqueueTask({ executionId: 'ex-auth', taskType: 'coding', goal: 'x', requiredCapabilities: [], payload: {}, assignedNodeId: 'node-b' });
    const client = new FederationHttpClient({ nodeId: 'node-a', secret: 'wrong-secret', state: nodeA, timeoutMs: 2_000 });
    await assert.rejects(() => client.dispatchTask({ endpoint: started.endpoint, task }), /invalid-signature|HTTP 401/i);
    assert.equal((await nodeB.listTasks()).length, 0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('federation http plane accepts signed node heartbeats and persists advertised health', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-fed-heartbeat-'));
  const secret = 'cluster-secret';
  const coordinatorState = new DurableFederationState({ stateFile: join(directory, 'coordinator.json'), localNodeId: 'coordinator', secret });
  await coordinatorState.init();
  const server = new FederationHttpServer({ nodeId: 'coordinator', secret, state: coordinatorState, execute: async () => ({ success: true }) });
  const started = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const workerState = new DurableFederationState({ stateFile: join(directory, 'worker.json'), localNodeId: 'worker-1', secret });
    await workerState.init();
    const client = new FederationHttpClient({ nodeId: 'worker-1', secret, state: workerState, timeoutMs: 2_000 });
    const ack = await client.sendHeartbeat({
      endpoint: started.endpoint,
      targetNodeId: 'coordinator',
      node: { id: 'worker-1', endpoint: 'https://worker-1.example', capabilities: ['coding', 'testing'], load: 2 },
    });

    assert.equal(ack.nodeId, 'coordinator');
    assert.equal(ack.acceptedNodeId, 'worker-1');
    const persisted = (await coordinatorState.listNodes()).find((node) => node.id === 'worker-1');
    assert.equal(persisted?.status, 'online');
    assert.equal(persisted?.endpoint, 'https://worker-1.example');
    assert.deepEqual(persisted?.capabilities, ['coding', 'testing']);
    assert.equal(persisted?.load, 2);
    assert.ok(persisted?.lastHeartbeat);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('leased federation HTTP results preserve fencing tokens and commit idempotently at the origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-fed-leased-http-'));
  const secret = 'cluster-secret';
  let calls = 0;
  const workerState = new DurableFederationState({ stateFile: join(directory, 'worker.json'), localNodeId: 'node-b', secret });
  await workerState.init();
  const server = new FederationHttpServer({
    nodeId: 'node-b',
    secret,
    state: workerState,
    execute: async () => {
      calls += 1;
      return { success: true, output: { worker: 'node-b' } };
    },
  });
  const started = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const originState = new DurableFederationState({ stateFile: join(directory, 'origin.json'), localNodeId: 'coordinator', secret });
    await originState.init();
    const queued = await originState.enqueueTask({ executionId: 'ex-leased-http', taskType: 'coding', goal: 'Execute with fencing', requiredCapabilities: ['coding'], payload: {} });
    const leasedAt = Date.now();
    const lease = await originState.acquireLease(queued.id, 'node-b', { leaseMs: 10_000, now: leasedAt });
    const leasedTask = await originState.getTask(queued.id);
    assert.ok(leasedTask);
    const client = new FederationHttpClient({ nodeId: 'coordinator', secret, state: originState, timeoutMs: 2_000 });

    const first = await client.dispatchTask({ endpoint: started.endpoint, task: leasedTask });
    assert.equal(first.leaseId, lease.id);
    assert.equal(first.attempt, 1);
    assert.equal(first.nodeId, 'node-b');
    assert.equal(calls, 1);
    assert.equal((await originState.getTask(queued.id))?.status, 'completed');
    assert.equal((await originState.listLeases()).length, 0);
    assert.equal((await originState.listResults()).length, 1);

    const second = await client.dispatchTask({ endpoint: started.endpoint, task: leasedTask });
    assert.equal(second.id, first.id);
    assert.equal(second.leaseId, lease.id);
    assert.equal(second.attempt, 1);
    assert.equal(calls, 1);
    assert.equal((await workerState.listResults()).length, 1);
    assert.equal((await originState.listResults()).length, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
