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
