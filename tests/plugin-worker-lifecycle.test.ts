import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { HookEngine } from '../packages/hooks/src/index.js';
import {
  DurablePluginManager,
  DurablePluginStore,
  PluginArtifactStore,
  managedPluginSigningPayload,
  type ManagedPluginArtifactRecord,
  type ManagedPluginManifest,
  type PluginInstallPolicy,
  type PluginTrustStore,
} from '../packages/plugins/src/index.js';
import { ToolRegistry } from '../packages/tools/src/index.js';

class FakeWorkerRuntime {
  readonly starts: Array<{ pluginId: string; artifact: ManagedPluginArtifactRecord }> = [];
  readonly stops: string[] = [];
  readonly tools: Array<{ pluginId: string; name: string; input: Record<string, unknown> }> = [];
  readonly hooks: Array<{ pluginId: string; name: string; event: string }> = [];
  failStart = false;

  async start(pluginId: string, _manifest: ManagedPluginManifest, artifact: ManagedPluginArtifactRecord): Promise<void> {
    if (this.failStart) throw new Error('simulated isolated worker start failure');
    this.starts.push({ pluginId, artifact: structuredClone(artifact) });
  }

  async callTool(pluginId: string, name: string, input: Record<string, unknown>): Promise<unknown> {
    this.tools.push({ pluginId, name, input: structuredClone(input) });
    return { pluginId, name, input };
  }

  async callHook(pluginId: string, name: string, event: string, context: Record<string, unknown>): Promise<unknown> {
    this.hooks.push({ pluginId, name, event });
    return {
      hookId: `plugin:${pluginId}:hook:${name}`,
      action: 'continue',
      annotations: { worker: true, event, sessionId: context.sessionId },
    };
  }

  async stop(pluginId: string): Promise<void> {
    this.stops.push(pluginId);
  }
}

function signedWorkerFixture(artifactDigest: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: ManagedPluginManifest = {
    id: 'worker-lifecycle',
    name: 'Worker Lifecycle',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['tool:register', 'hook:register'],
    capabilities: ['analysis'],
    entrypoint: './worker.mjs',
    artifactDigest,
    signerKeyId: 'publisher-main',
    signature: '',
    contributions: {
      tools: [{
        name: 'inspect',
        description: 'Inspect input in isolated worker',
        risk: 'low',
        permissions: [],
        inputSchema: { required: ['text'], properties: { text: 'string' } },
      }],
      hooks: [{ name: 'audit', events: ['pre-tool'], priority: 10, critical: true, timeoutMs: 500 }],
    },
  };
  manifest.signature = sign(null, managedPluginSigningPayload(manifest), privateKey).toString('base64');
  const trust: PluginTrustStore = {
    keys: { 'publisher-main': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  };
  const policy: PluginInstallPolicy = {
    allowedPermissions: ['tool:register', 'hook:register'],
    allowedCapabilities: ['analysis'],
    allowedApiVersions: ['v1'],
  };
  return { manifest, trust, policy };
}

function managerFixture(directory: string, trust: PluginTrustStore, policy: PluginInstallPolicy, workers: FakeWorkerRuntime) {
  const tools = new ToolRegistry();
  const hooks = new HookEngine();
  const artifacts = new PluginArtifactStore({ directory: join(directory, 'artifacts') });
  const manager = new DurablePluginManager({
    store: new DurablePluginStore({ directory: join(directory, 'state') }),
    trust,
    policy,
    tools,
    hooks,
    agents: new AgentRegistry(false),
    artifacts,
    workers,
  });
  return { manager, tools, hooks, artifacts };
}

test('durable plugin manager installs verified artifact and routes enabled tool/hook contributions through worker RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-worker-lifecycle-'));
  try {
    const artifactBytes = Buffer.from('export const fixture = true;\n', 'utf8');
    const digest = createHash('sha256').update(artifactBytes).digest('hex');
    const source = join(directory, 'worker.mjs');
    await writeFile(source, artifactBytes);
    const { manifest, trust, policy } = signedWorkerFixture(digest);
    const workers = new FakeWorkerRuntime();
    const { manager, tools, hooks } = managerFixture(directory, trust, policy, workers);
    await manager.init();

    const installed = await manager.install(manifest, source);
    assert.equal(installed.status, 'installed');
    assert.equal(installed.artifact?.digest, digest);
    assert.notEqual(installed.artifact?.path, source);

    const enabled = await manager.enable(manifest.id);
    assert.equal(enabled.status, 'enabled');
    assert.equal(workers.starts.length, 1);
    assert.equal(workers.starts[0]?.artifact.digest, digest);

    const toolName = `plugin:${manifest.id}:tool:inspect`;
    const request = tools.request(toolName, 'execution-1', 'agent-1', { text: 'hello' });
    const toolResult = await tools.executeAuthorized(request, async () => true) as { name: string; input: { text: string } };
    assert.equal(toolResult.name, 'inspect');
    assert.equal(toolResult.input.text, 'hello');
    assert.equal(workers.tools.length, 1);

    const hookResult = await hooks.run({
      event: 'pre-tool',
      sessionId: 'session-1',
      cwd: directory,
      timestamp: new Date().toISOString(),
      payload: { tool: toolName },
      metadata: {},
    });
    assert.equal(hookResult.action, 'continue');
    assert.equal(hookResult.annotations.worker, true);
    assert.equal(workers.hooks.length, 1);

    const disabled = await manager.disable(manifest.id);
    assert.equal(disabled.status, 'disabled');
    assert.deepEqual(workers.stops, [manifest.id]);
    assert.throws(() => tools.get(toolName), /unknown tool/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('enabled worker plugin rehydrates from durable artifact and failed worker start rolls back cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-worker-restart-'));
  try {
    const artifactBytes = Buffer.from('export const fixture = true;\n', 'utf8');
    const digest = createHash('sha256').update(artifactBytes).digest('hex');
    const source = join(directory, 'worker.mjs');
    await writeFile(source, artifactBytes);
    const { manifest, trust, policy } = signedWorkerFixture(digest);

    const firstWorkers = new FakeWorkerRuntime();
    const first = managerFixture(directory, trust, policy, firstWorkers);
    await first.manager.init();
    await first.manager.install(manifest, source);
    await first.manager.enable(manifest.id);

    const restoredWorkers = new FakeWorkerRuntime();
    const restored = managerFixture(directory, trust, policy, restoredWorkers);
    await restored.manager.init();
    assert.equal((await restored.manager.get(manifest.id))?.status, 'enabled');
    assert.equal(restoredWorkers.starts.length, 1);
    assert.equal(restoredWorkers.starts[0]?.artifact.digest, digest);
    assert.equal(restored.tools.get(`plugin:${manifest.id}:tool:inspect`).source, 'plugin');

    await restored.manager.disable(manifest.id);
    const failingWorkers = new FakeWorkerRuntime();
    failingWorkers.failStart = true;
    const failing = managerFixture(directory, trust, policy, failingWorkers);
    await failing.manager.init();
    await assert.rejects(() => failing.manager.enable(manifest.id), /worker start failure/i);
    assert.equal((await failing.manager.get(manifest.id))?.status, 'disabled');
    assert.equal(failing.tools.list().length, 0);
    assert.equal(failing.hooks.list().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
