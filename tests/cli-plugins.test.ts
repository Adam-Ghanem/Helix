import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { managedPluginSigningPayload, type ManagedPluginManifest } from '../packages/plugins/src/index.js';

function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'dist/apps/cli/src/index.js'), ...args], { env: { ...process.env, ...env }, shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject); child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function signedManifest(permissions: string[] = ['skill:register']) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: ManagedPluginManifest = {
    id: 'reviewer',
    name: 'Reviewer',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions,
    capabilities: ['analysis'],
    entrypoint: './plugin.js',
    artifactDigest: createHash('sha256').update('reviewer-artifact').digest('hex'),
    signerKeyId: 'publisher-main',
    signature: '',
    contributions: permissions.includes('skill:register')
      ? { skills: [{ name: 'review', description: 'Review code', instructions: 'Inspect the change and report concrete findings.' }] }
      : undefined,
  };
  manifest.signature = sign(null, managedPluginSigningPayload(manifest), privateKey).toString('base64');
  return {
    manifest,
    trustJson: JSON.stringify({ 'publisher-main': publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
  };
}

test('cli manages a signed durable plugin lifecycle across separate processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-plugins-'));
  try {
    const signed = signedManifest();
    const manifestPath = join(directory, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(signed.manifest), 'utf8');
    const env = {
      HELIX_DATA_DIR: join(directory, '.helix'),
      HELIX_PLUGIN_TRUST_KEYS: signed.trustJson,
      HELIX_PLUGIN_ALLOWED_PERMISSIONS: 'skill:register',
      HELIX_PLUGIN_ALLOWED_CAPABILITIES: 'analysis',
      HELIX_PLUGIN_ALLOWED_API_VERSIONS: 'v1',
    };

    const help = await cli(['help'], env);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /helix plugins list/i);
    assert.match(help.stdout, /helix plugins install/i);

    const empty = await cli(['plugins', 'list', '--json'], env);
    assert.equal(empty.code, 0, empty.stderr);
    assert.deepEqual((JSON.parse(empty.stdout) as { plugins: unknown[] }).plugins, []);

    const install = await cli(['plugins', 'install', manifestPath, '--json'], env);
    assert.equal(install.code, 0, install.stderr);
    assert.equal((JSON.parse(install.stdout) as { status: string }).status, 'installed');

    const inspect = await cli(['plugins', 'inspect', 'reviewer', '--json'], env);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal((JSON.parse(inspect.stdout) as { manifest: { id: string } }).manifest.id, 'reviewer');

    const enable = await cli(['plugins', 'enable', 'reviewer', '--json'], env);
    assert.equal(enable.code, 0, enable.stderr);
    assert.equal((JSON.parse(enable.stdout) as { status: string }).status, 'enabled');

    const listed = await cli(['plugins', 'list', '--json'], env);
    assert.equal(listed.code, 0, listed.stderr);
    const plugins = (JSON.parse(listed.stdout) as { plugins: Array<{ manifest: { id: string }; status: string }> }).plugins;
    assert.deepEqual(plugins.map((plugin) => [plugin.manifest.id, plugin.status]), [['reviewer', 'enabled']]);

    const disable = await cli(['plugins', 'disable', 'reviewer', '--json'], env);
    assert.equal(disable.code, 0, disable.stderr);
    assert.equal((JSON.parse(disable.stdout) as { status: string }).status, 'disabled');

    const remove = await cli(['plugins', 'remove', 'reviewer', '--json'], env);
    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual(JSON.parse(remove.stdout), { id: 'reviewer', removed: true });

    const missing = await cli(['plugins', 'inspect', 'reviewer', '--json'], env);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /unknown plugin/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cli plugin policy fails closed for malformed trust configuration and denied permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-plugin-policy-'));
  try {
    const signed = signedManifest(['network:egress']);
    const manifestPath = join(directory, 'unsafe.json');
    await writeFile(manifestPath, JSON.stringify(signed.manifest), 'utf8');
    const base = {
      HELIX_DATA_DIR: join(directory, '.helix'),
      HELIX_PLUGIN_ALLOWED_PERMISSIONS: 'skill:register',
      HELIX_PLUGIN_ALLOWED_CAPABILITIES: 'analysis',
      HELIX_PLUGIN_ALLOWED_API_VERSIONS: 'v1',
    };

    const malformed = await cli(['plugins', 'list', '--json'], { ...base, HELIX_PLUGIN_TRUST_KEYS: '{bad' });
    assert.notEqual(malformed.code, 0);
    assert.match(malformed.stderr, /HELIX_PLUGIN_TRUST_KEYS/i);

    const denied = await cli(['plugins', 'install', manifestPath, '--json'], { ...base, HELIX_PLUGIN_TRUST_KEYS: signed.trustJson });
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /permission denied/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
