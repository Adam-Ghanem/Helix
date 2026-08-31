import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StrictPluginWorkerSandboxFactory,
  managedPluginSigningPayload,
  type ManagedPluginManifest,
} from '../packages/plugins/src/index.js';
import { BubblewrapSandbox } from '../packages/sandbox/src/index.js';

function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'dist/apps/cli/src/index.js'), ...args], {
      env: { ...process.env, ...env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function signedExecutableManifest(artifactBytes: Buffer, permissions: string[] = ['tool:register']) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: ManagedPluginManifest = {
    id: 'isolated-cli-worker',
    name: 'Isolated CLI Worker',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions,
    capabilities: ['analysis'],
    entrypoint: './worker.mjs',
    artifactDigest: createHash('sha256').update(artifactBytes).digest('hex'),
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
  return {
    manifest,
    trustJson: JSON.stringify({ 'publisher-main': publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
  };
}

function policyEnv(directory: string, trustJson: string, permissions = 'tool:register') {
  return {
    HELIX_DATA_DIR: join(directory, '.helix'),
    HELIX_PLUGIN_TRUST_KEYS: trustJson,
    HELIX_PLUGIN_ALLOWED_PERMISSIONS: permissions,
    HELIX_PLUGIN_ALLOWED_CAPABILITIES: 'analysis',
    HELIX_PLUGIN_ALLOWED_API_VERSIONS: 'v1',
  };
}

test('strict plugin sandbox factory mounts only the verified artifact read-only and derives network exactly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-factory-'));
  try {
    const artifact = join(directory, 'artifact.mjs');
    await writeFile(artifact, 'export {};\n', 'utf8');
    const factory = new StrictPluginWorkerSandboxFactory({
      workspaceRoot: join(directory, 'workspaces'),
      bwrapExecutable: '/usr/bin/bwrap',
      runtimeReadOnlyPaths: ['/usr', '/bin', '/lib', '/lib64'],
      backendAvailability: { bubblewrap: true, prlimit: false },
    });
    const manifest = { id: 'factory-plugin' } as ManagedPluginManifest;
    const base = {
      pluginId: 'factory-plugin',
      manifest,
      artifact: { digest: 'a'.repeat(64), path: artifact, size: 11 },
      nodeExecutable: '/usr/bin/node',
    };

    const offline = await factory.create({ ...base, network: false });
    assert.equal(offline.isolated, true);
    assert.ok(offline instanceof BubblewrapSandbox);
    const offlinePlan = (offline as BubblewrapSandbox).plan('/usr/bin/node', ['/plugin/worker.mjs']);
    const joined = offlinePlan.args.join('\n');
    assert.match(joined, /--unshare-net/);
    const roIndex = offlinePlan.args.findIndex((value, index) => value === '--ro-bind' && offlinePlan.args[index + 1] === artifact);
    assert.notEqual(roIndex, -1);
    assert.equal(offlinePlan.args[roIndex + 2], '/plugin/worker.mjs');
    assert.match(offlinePlan.cwd, /factory-plugin/);

    const online = await factory.create({ ...base, network: true });
    const onlinePlan = (online as BubblewrapSandbox).plan('/usr/bin/node', ['/plugin/worker.mjs']);
    assert.equal(onlinePlan.args.includes('--unshare-net'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('strict plugin sandbox factory fails closed when Bubblewrap isolation is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-factory-unavailable-'));
  try {
    const artifact = join(directory, 'artifact.mjs');
    await writeFile(artifact, 'export {};\n', 'utf8');
    const factory = new StrictPluginWorkerSandboxFactory({
      workspaceRoot: join(directory, 'workspaces'),
      backendAvailability: { bubblewrap: false, prlimit: false },
    });
    await assert.rejects(() => factory.create({
      pluginId: 'factory-plugin',
      manifest: { id: 'factory-plugin' } as ManagedPluginManifest,
      artifact: { digest: 'a'.repeat(64), path: artifact, size: 11 },
      nodeExecutable: '/usr/bin/node',
      network: false,
    }), /isolated|bubblewrap|unavailable/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI resolves executable entrypoint relative to manifest, stores artifact, and fails enable closed without Bubblewrap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-plugin-worker-'));
  try {
    const packageDirectory = join(directory, 'package');
    const manifestPath = join(packageDirectory, 'plugin.json');
    const workerPath = join(packageDirectory, 'worker.mjs');
    const workerBytes = Buffer.from(`import { createInterface } from 'node:readline';\nconst rl=createInterface({input:process.stdin});\nrl.on('line',(line)=>{const r=JSON.parse(line);if(r.method==='plugin/handshake')console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'1',pluginId:'isolated-cli-worker',capabilities:{tools:true,hooks:false}}}));});\n`, 'utf8');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(packageDirectory, { recursive: true }));
    await writeFile(workerPath, workerBytes);
    const signed = signedExecutableManifest(workerBytes);
    await writeFile(manifestPath, JSON.stringify(signed.manifest), 'utf8');
    const env = {
      ...policyEnv(directory, signed.trustJson),
      HELIX_PLUGIN_BWRAP_EXECUTABLE: join(directory, 'missing-bwrap'),
      HELIX_PLUGIN_NODE_EXECUTABLE: process.execPath,
    };

    const install = await cli(['plugins', 'install', manifestPath, '--json'], env);
    assert.equal(install.code, 0, install.stderr);
    const installed = JSON.parse(install.stdout) as { artifact?: { digest: string; path: string } };
    assert.equal(installed.artifact?.digest, signed.manifest.artifactDigest);
    assert.ok(installed.artifact?.path);
    assert.notEqual(installed.artifact?.path, workerPath);
    assert.equal(dirname(installed.artifact!.path).endsWith('sha256'), true);

    await rm(workerPath, { force: true });
    const inspect = await cli(['plugins', 'inspect', signed.manifest.id, '--json'], env);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal((JSON.parse(inspect.stdout) as { artifact: { digest: string } }).artifact.digest, signed.manifest.artifactDigest);

    const enable = await cli(['plugins', 'enable', signed.manifest.id, '--json'], env);
    assert.notEqual(enable.code, 0);
    assert.match(enable.stderr, /isolated|bubblewrap|unavailable/i);

    const after = await cli(['plugins', 'inspect', signed.manifest.id, '--json'], env);
    assert.equal(after.code, 0, after.stderr);
    assert.equal((JSON.parse(after.stdout) as { status: string }).status, 'installed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HELIX_PLUGIN_NODE_EXECUTABLE is fail-closed and must be absolute', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-plugin-node-'));
  try {
    const env = {
      HELIX_DATA_DIR: join(directory, '.helix'),
      HELIX_PLUGIN_TRUST_KEYS: '{}',
      HELIX_PLUGIN_ALLOWED_PERMISSIONS: '',
      HELIX_PLUGIN_ALLOWED_CAPABILITIES: '',
      HELIX_PLUGIN_ALLOWED_API_VERSIONS: 'v1',
      HELIX_PLUGIN_NODE_EXECUTABLE: 'node',
    };
    const list = await cli(['plugins', 'list', '--json'], env);
    assert.notEqual(list.code, 0);
    assert.match(list.stderr, /HELIX_PLUGIN_NODE_EXECUTABLE.*absolute/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
