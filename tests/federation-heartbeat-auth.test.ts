import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableFederationState, FederationHttpClient, FederationHttpServer } from '../packages/federation/src/index.js';

test('federation heartbeat rejects the wrong cluster secret without registering the node', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-fed-heartbeat-auth-'));
  const coordinatorState = new DurableFederationState({ stateFile: join(directory, 'coordinator.json'), localNodeId: 'coordinator', secret: 'right-secret' });
  await coordinatorState.init();
  const server = new FederationHttpServer({ nodeId: 'coordinator', secret: 'right-secret', state: coordinatorState, execute: async () => ({ success: true }) });
  const started = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const workerState = new DurableFederationState({ stateFile: join(directory, 'worker.json'), localNodeId: 'worker-1', secret: 'wrong-secret' });
    await workerState.init();
    const client = new FederationHttpClient({ nodeId: 'worker-1', secret: 'wrong-secret', state: workerState, timeoutMs: 2_000 });

    await assert.rejects(() => client.sendHeartbeat({
      endpoint: started.endpoint,
      targetNodeId: 'coordinator',
      node: { id: 'worker-1', endpoint: 'https://worker-1.example', capabilities: ['coding'], load: 0 },
    }), /invalid-signature|HTTP 401/i);
    assert.equal((await coordinatorState.listNodes()).length, 0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
