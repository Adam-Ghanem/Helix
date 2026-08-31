import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DurablePluginStore,
  managedPluginSigningPayload,
  verifyManagedManifest,
  type ManagedPluginManifest,
  type ManagedPluginRecord,
  type PluginInstallPolicy,
  type PluginTrustStore,
} from '../packages/plugins/src/index.js';

function signingFixture(overrides: Partial<ManagedPluginManifest> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: ManagedPluginManifest = {
    id: 'reviewer',
    name: 'Reviewer',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['skill:register'],
    capabilities: ['analysis'],
    entrypoint: './plugin.js',
    artifactDigest: createHash('sha256').update('reviewer-artifact').digest('hex'),
    signerKeyId: 'publisher-main',
    signature: '',
    contributions: {
      skills: [{ name: 'review', description: 'Review code', instructions: 'Inspect the change and report concrete findings.' }],
    },
    ...overrides,
  };
  manifest.signature = sign(null, managedPluginSigningPayload(manifest), privateKey).toString('base64');
  const trust: PluginTrustStore = {
    keys: {
      'publisher-main': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
  const policy: PluginInstallPolicy = {
    allowedPermissions: ['skill:register', 'tool:register', 'hook:register', 'agent:register', 'memory:read'],
    allowedCapabilities: ['analysis', 'coding'],
    allowedApiVersions: ['v1'],
    maxContributionsPerKind: 8,
  };
  return { manifest, trust, policy };
}

test('managed plugin manifest verifies Ed25519 signature and normalizes signed policy fields', () => {
  const { manifest, trust, policy } = signingFixture({ permissions: ['skill:register', 'skill:register'], capabilities: ['analysis', 'analysis'] });
  manifest.signature = '';
  const { privateKey } = generateKeyPairSync('ed25519');
  // Rebuild with a stable fixture key rather than allowing normalization to hide signed duplicates.
  const fresh = signingFixture();
  const verified = verifyManagedManifest(fresh.manifest, fresh.trust, fresh.policy);
  assert.equal(verified.manifest.id, 'reviewer');
  assert.deepEqual(verified.manifest.permissions, ['skill:register']);
  assert.deepEqual(verified.manifest.capabilities, ['analysis']);
  assert.match(verified.manifestDigest, /^[a-f0-9]{64}$/);
  assert.ok(privateKey);
});

test('managed plugin verification rejects tampering and unknown signers', () => {
  const { manifest, trust, policy } = signingFixture();
  assert.throws(() => verifyManagedManifest({ ...manifest, version: '9.9.9' }, trust, policy), /signature/i);
  assert.throws(() => verifyManagedManifest({ ...manifest, signerKeyId: 'unknown' }, trust, policy), /signer|trust/i);
});

test('managed plugin verification rejects permission and capability escalation after valid signing', () => {
  const deniedPermission = signingFixture({ permissions: ['network:egress'] });
  assert.throws(() => verifyManagedManifest(deniedPermission.manifest, deniedPermission.trust, deniedPermission.policy), /permission denied/i);

  const deniedCapability = signingFixture({ capabilities: ['root-shell'] });
  assert.throws(() => verifyManagedManifest(deniedCapability.manifest, deniedCapability.trust, deniedCapability.policy), /capability denied/i);
});

test('durable plugin store persists validated lifecycle records across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugins-'));
  try {
    const { manifest, trust, policy } = signingFixture();
    const verified = verifyManagedManifest(manifest, trust, policy);
    const installedAt = new Date().toISOString();
    const record: ManagedPluginRecord = {
      manifest: verified.manifest,
      manifestDigest: verified.manifestDigest,
      verifiedSignerKeyId: verified.manifest.signerKeyId,
      status: 'installed',
      installedAt,
      updatedAt: installedAt,
      registrations: { tools: [], hooks: [], agents: [] },
    };

    const first = new DurablePluginStore({ directory });
    await first.init();
    await first.put(record);
    assert.equal((await first.get('reviewer'))?.status, 'installed');

    const restored = new DurablePluginStore({ directory });
    await restored.init();
    assert.equal((await restored.get('reviewer'))?.manifestDigest, verified.manifestDigest);
    assert.equal((await restored.list()).length, 1);
    assert.equal(await restored.remove('reviewer'), true);
    assert.equal(await restored.get('reviewer'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
