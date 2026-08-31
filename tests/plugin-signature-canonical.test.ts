import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  managedPluginSigningPayload,
  verifyManagedManifest,
  type ManagedPluginManifest,
  type PluginInstallPolicy,
  type PluginTrustStore,
} from '../packages/plugins/src/index.js';

test('managed signature remains valid after normalization removes duplicate signed set fields', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: ManagedPluginManifest = {
    id: 'canonical-reviewer',
    name: 'Canonical Reviewer',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['skill:register', 'skill:register'],
    capabilities: ['analysis', 'analysis'],
    tools: ['inspect', 'inspect'],
    entrypoint: './plugin.js',
    artifactDigest: createHash('sha256').update('artifact').digest('hex'),
    signerKeyId: 'publisher',
    signature: '',
    contributions: {
      skills: [{ name: 'review', description: 'Review', instructions: 'Review the change.' }],
    },
  };
  manifest.signature = sign(null, managedPluginSigningPayload(manifest), privateKey).toString('base64');
  const trust: PluginTrustStore = { keys: { publisher: publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const policy: PluginInstallPolicy = {
    allowedPermissions: ['skill:register'],
    allowedCapabilities: ['analysis'],
    allowedApiVersions: ['v1'],
  };

  const first = verifyManagedManifest(manifest, trust, policy);
  assert.deepEqual(first.manifest.permissions, ['skill:register']);
  assert.deepEqual(first.manifest.capabilities, ['analysis']);
  assert.deepEqual(first.manifest.tools, ['inspect']);
  assert.doesNotThrow(() => verifyManagedManifest(first.manifest, trust, policy));
});
