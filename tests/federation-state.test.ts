import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableFederationState, FederationRegistry, FederationRouter } from '../packages/federation/src/index.js';

test('durable federation state persists nodes, tasks, results and replay protection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-fed-state-'));
  try {
    const stateFile = join(directory, 'federation.json');
    const secret = 'shared-secret';
    const registry = new FederationRegistry();
    const state = new DurableFederationState({ stateFile, localNodeId: 'node-b', secret });
    await state.init();
    await state.upsertNode({ id: 'node-a', endpoint: 'http://127.0.0.1:10001', capabilities: ['coding'], status: 'online', load: 2 });
    const message = registry.sign('node-a', 'node-b', { kind: 'test' }, secret, 60_000);
    const accepted = await state.acceptMessage(message);
    assert.equal(accepted.accepted, true);
    assert.equal((await state.acceptMessage(message)).reason, 'replay');

    const task = await state.enqueueTask({ executionId: 'ex-1', taskType: 'coding', goal: 'Implement API', requiredCapabilities: ['coding'], payload: { x: 1 }, assignedNodeId: 'node-a' });
    await state.updateTask(task.id, { status: 'running', attempt: 2 });
    const result = await state.appendResult({ taskId: task.id, executionId: 'ex-1', nodeId: 'node-a', success: true, output: { ok: true } });

    const restored = new DurableFederationState({ stateFile, localNodeId: 'node-b', secret });
    await restored.init();
    assert.equal((await restored.listNodes())[0]?.id, 'node-a');
    assert.equal((await restored.getTask(task.id))?.status, 'running');
    assert.equal((await restored.getResult(result.id))?.taskId, task.id);
    assert.equal((await restored.acceptMessage(message)).reason, 'replay');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('durable federation state rejects tampered, expired, wrong-recipient and nonce-replay messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-fed-guard-'));
  try {
    const secret = 'secret';
    const registry = new FederationRegistry();
    const state = new DurableFederationState({ stateFile: join(directory, 'state.json'), localNodeId: 'node-b', secret });
    await state.init();
    const valid = registry.sign('node-a', 'node-b', { value: 1 }, secret, 60_000);
    const tampered = { ...valid, payload: { value: 2 } };
    assert.equal((await state.acceptMessage(tampered)).reason, 'invalid-signature');
    const wrong = registry.sign('node-a', 'node-c', { value: 1 }, secret, 60_000);
    assert.equal((await state.acceptMessage(wrong)).reason, 'wrong-recipient');
    const expired = registry.sign('node-a', 'node-b', { value: 1 }, secret, 1);
    assert.equal((await state.acceptMessage(expired, Date.now() + 10_000)).reason, 'expired');
    assert.equal((await state.acceptMessage(valid)).accepted, true);
    const sameNonce = registry.sign('node-a', 'node-b', { value: 9 }, secret, 60_000);
    sameNonce.nonce = valid.nonce;
    assert.equal((await state.acceptMessage(sameNonce)).reason, 'invalid-signature');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('federation router selects capable online node by load then heartbeat freshness', () => {
  const router = new FederationRouter();
  const now = Date.now();
  const nodes = [
    { id: 'busy', endpoint: 'https://busy.example', capabilities: ['coding', 'testing'], status: 'online' as const, lastHeartbeat: new Date(now).toISOString(), load: 9 },
    { id: 'fresh', endpoint: 'https://fresh.example', capabilities: ['coding', 'testing'], status: 'online' as const, lastHeartbeat: new Date(now).toISOString(), load: 1 },
    { id: 'stale', endpoint: 'https://stale.example', capabilities: ['coding', 'testing'], status: 'online' as const, lastHeartbeat: new Date(now - 60_000).toISOString(), load: 1 },
    { id: 'offline', endpoint: 'https://offline.example', capabilities: ['coding', 'testing'], status: 'offline' as const, load: 0 },
  ];
  assert.equal(router.select(nodes, ['coding', 'testing'])?.id, 'fresh');
  assert.equal(router.select(nodes, ['gpu']), undefined);
});
