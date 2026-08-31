import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyManagedManifest, type ManagedPluginManifest, type PluginInstallPolicy, type PluginTrustStore } from '../packages/plugins/src/index.js';

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
