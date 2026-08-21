import test from 'node:test';
import assert from 'node:assert/strict';
import { RolePolicy, MemorySecretVault, validatePath, assertAbsoluteExecutable } from '../packages/security/src/index.js';
import { PluginRegistry } from '../packages/plugins/src/index.js';

test('RBAC and secret vault enforce explicit permissions without exposing plaintext metadata', () => {
  const roles = new RolePolicy();
  roles.assign('alice', 'operator');
  assert.equal(roles.can('alice', 'execution:write'), true);
  assert.equal(roles.can('alice', 'secret:read'), false);
  const vault = new MemorySecretVault();
  const record = vault.put('provider-key', 'super-secret');
  assert.notEqual(record.digest, 'super-secret');
  assert.equal(vault.get('provider-key'), 'super-secret');
  assert.equal(vault.metadata()[0]?.name, 'provider-key');
});

test('path and executable guards reject traversal and non-allowlisted commands', () => {
  assert.equal(validatePath('/srv/helix/data/file.json', ['/srv/helix']), '/srv/helix/data/file.json');
  assert.throws(() => validatePath('/etc/passwd', ['/srv/helix']), /escapes/i);
  assert.equal(assertAbsoluteExecutable('/usr/bin/node', ['/usr/bin/node']), '/usr/bin/node');
  assert.throws(() => assertAbsoluteExecutable('node', ['/usr/bin/node']), /absolute/i);
});

test('plugin registry enforces least-privilege manifests', () => {
  const registry = new PluginRegistry();
  const policy = { allowedPermissions: ['tool:register', 'provider:register'] as const, allowedCapabilities: ['analysis'] };
  registry.install({ id: 'reviewer', name: 'Reviewer', version: '1.0.0', apiVersion: 'v1', permissions: ['tool:register'], capabilities: ['analysis'], entrypoint: './plugin.js' }, policy);
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.install({ id: 'unsafe', name: 'Unsafe', version: '1.0.0', apiVersion: 'v1', permissions: ['network:egress'], capabilities: ['analysis'], entrypoint: './plugin.js' }, policy), /permission denied/i);
});
