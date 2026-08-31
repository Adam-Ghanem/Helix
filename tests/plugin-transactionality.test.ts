import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { HookEngine } from '../packages/hooks/src/index.js';
import {
  DurablePluginManager,
  DurablePluginStore,
  managedPluginSigningPayload,
  verifyManagedManifest,
  type ManagedPluginManifest,
  type ManagedPluginRecord,
  type PluginInstallPolicy,
  type PluginTrustStore,
} from '../packages/plugins/src/index.js';
import { ToolRegistry } from '../packages/tools/src/index.js';

function signedToolFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: ManagedPluginManifest = {
    id: 'transactional-tool',
    name: 'Transactional Tool',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['tool:register'],
    capabilities: ['analysis'],
    entrypoint: './plugin.js',
    artifactDigest: createHash('sha256').update('transactional-tool-artifact').digest('hex'),
    signerKeyId: 'publisher-main',
    signature: '',
    contributions: {
      tools: [{
        name: 'inspect',
        description: 'Inspect input',
        risk: 'low',
        permissions: [],
        inputSchema: { properties: { text: 'string' } },
      }],
    },
  };
  manifest.signature = sign(null, managedPluginSigningPayload(manifest), privateKey).toString('base64');
  const trust: PluginTrustStore = {
    keys: { 'publisher-main': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  };
  const policy: PluginInstallPolicy = {
    allowedPermissions: ['tool:register'],
    allowedCapabilities: ['analysis'],
    allowedApiVersions: ['v1'],
  };
  return { manifest, trust, policy };
}

function installedRecord(): ManagedPluginRecord {
  const fixture = signedToolFixture();
  const verified = verifyManagedManifest(fixture.manifest, fixture.trust, fixture.policy);
  const now = new Date().toISOString();
  return {
    manifest: verified.manifest,
    manifestDigest: verified.manifestDigest,
    verifiedSignerKeyId: verified.manifest.signerKeyId,
    status: 'installed',
    installedAt: now,
    updatedAt: now,
    registrations: { tools: [], hooks: [], agents: [] },
  };
}

test('durable plugin store rolls back in-memory put and remove when persistence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-store-transaction-'));
  try {
    const store = new DurablePluginStore({ directory });
    await store.init();
    const original = installedRecord();
    await store.put(original);

    const internal = store as unknown as { persist: () => Promise<void> };
    internal.persist = async () => { throw new Error('simulated disk failure'); };

    const updated: ManagedPluginRecord = { ...structuredClone(original), status: 'disabled', updatedAt: new Date(Date.now() + 1_000).toISOString() };
    await assert.rejects(() => store.put(updated), /disk failure/i);
    assert.equal((await store.get(original.manifest.id))?.status, 'installed');

    await assert.rejects(() => store.remove(original.manifest.id), /disk failure/i);
    assert.equal((await store.get(original.manifest.id))?.status, 'installed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plugin disable and uninstall preserve active runtime ownership when durable mutation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-manager-transaction-'));
  try {
    const { manifest, trust, policy } = signedToolFixture();
    const tools = new ToolRegistry();
    const store = new DurablePluginStore({ directory });
    const manager = new DurablePluginManager({
      store,
      trust,
      policy,
      tools,
      hooks: new HookEngine(),
      agents: new AgentRegistry(false),
      handlers: {
        tool: async () => async (input: Record<string, unknown>) => ({ input }),
      },
    });
    await manager.init();
    await manager.install(manifest);
    await manager.enable(manifest.id);
    const toolName = `plugin:${manifest.id}:tool:inspect`;
    assert.equal(tools.get(toolName).source, 'plugin');

    const originalPut = store.put.bind(store);
    (store as unknown as { put: DurablePluginStore['put'] }).put = async () => { throw new Error('simulated put failure'); };
    await assert.rejects(() => manager.disable(manifest.id), /put failure/i);
    assert.equal((await manager.get(manifest.id))?.status, 'enabled');
    assert.equal(tools.get(toolName).source, 'plugin');
    (store as unknown as { put: DurablePluginStore['put'] }).put = originalPut;

    const originalRemove = store.remove.bind(store);
    (store as unknown as { remove: DurablePluginStore['remove'] }).remove = async () => { throw new Error('simulated remove failure'); };
    await assert.rejects(() => manager.uninstall(manifest.id), /remove failure/i);
    assert.equal((await manager.get(manifest.id))?.status, 'enabled');
    assert.equal(tools.get(toolName).source, 'plugin');
    (store as unknown as { remove: DurablePluginStore['remove'] }).remove = originalRemove;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
