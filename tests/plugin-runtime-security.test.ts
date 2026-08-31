import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { HookEngine } from '../packages/hooks/src/index.js';
import {
  DurablePluginManager,
  DurablePluginStore,
  verifyManagedManifest,
  type ManagedPluginManifest,
  type ManagedPluginRecord,
  type PluginInstallPolicy,
  type PluginTrustStore,
} from '../packages/plugins/src/index.js';
import { ToolRegistry } from '../packages/tools/src/index.js';

const policy: PluginInstallPolicy = {
  allowedPermissions: ['skill:register'],
  allowedCapabilities: ['analysis'],
  allowedApiVersions: ['v1'],
};
const trust: PluginTrustStore = { keys: {} };

test('managed verifier rejects malformed runtime JSON with explicit validation errors instead of TypeError', () => {
  const malformed = {
    id: 'runtime-json',
    name: 42,
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['skill:register'],
    capabilities: ['analysis'],
    entrypoint: './plugin.js',
    artifactDigest: 'a'.repeat(64),
    signerKeyId: 'publisher',
    signature: 'AA==',
  } as unknown as ManagedPluginManifest;

  assert.throws(
    () => verifyManagedManifest(malformed, trust, policy),
    (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /plugin manifest|name/i.test(error.message),
  );
});

test('managed verifier rejects malformed nested contribution arrays before signature processing', () => {
  const malformed = {
    id: 'runtime-json',
    name: 'Runtime JSON',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['skill:register'],
    capabilities: ['analysis'],
    entrypoint: './plugin.js',
    artifactDigest: 'a'.repeat(64),
    signerKeyId: 'publisher',
    signature: 'AA==',
    contributions: { skills: 'not-an-array' },
  } as unknown as ManagedPluginManifest;

  assert.throws(
    () => verifyManagedManifest(malformed, trust, policy),
    (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /contribution|skills|manifest/i.test(error.message),
  );
});

test('plugin manager rejects unverified installed durable state during restart, not only enabled plugins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-tamper-'));
  try {
    const store = new DurablePluginStore({ directory });
    await store.init();
    const now = new Date().toISOString();
    const record: ManagedPluginRecord = {
      manifest: {
        id: 'tampered',
        name: 'Tampered',
        version: '1.0.0',
        apiVersion: 'v1',
        permissions: ['skill:register'],
        capabilities: ['analysis'],
        entrypoint: './plugin.js',
        artifactDigest: 'a'.repeat(64),
        signerKeyId: 'unknown-publisher',
        signature: 'AA==',
        contributions: { skills: [{ name: 'review', description: 'Review', instructions: 'Review the change.' }] },
      },
      manifestDigest: 'b'.repeat(64),
      verifiedSignerKeyId: 'unknown-publisher',
      status: 'installed',
      installedAt: now,
      updatedAt: now,
      registrations: { tools: [], hooks: [], agents: [] },
    };
    await store.put(record);

    const manager = new DurablePluginManager({
      store: new DurablePluginStore({ directory }),
      trust,
      policy,
      tools: new ToolRegistry(),
      hooks: new HookEngine(),
      agents: new AgentRegistry(false),
    });

    await assert.rejects(() => manager.init(), /signer|signature|digest|trust/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
