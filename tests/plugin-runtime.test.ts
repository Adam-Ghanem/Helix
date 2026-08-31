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

function lifecycleFixture() {
  return signingFixture({
    permissions: ['tool:register', 'hook:register', 'agent:register', 'skill:register', 'memory:read'],
    capabilities: ['analysis', 'coding'],
    contributions: {
      tools: [{ name: 'inspect', description: 'Inspect input', risk: 'low', permissions: ['memory:read'], inputSchema: { required: ['text'], properties: { text: 'string' } } }],
      hooks: [{ name: 'audit', events: ['pre-tool'], priority: 10, critical: true, timeoutMs: 500 }],
      agents: [{ name: 'specialist', role: 'Plugin specialist', capabilities: ['analysis'], permissions: ['memory:read'] }],
      skills: [{ name: 'review', description: 'Review code', instructions: 'Inspect the change and report concrete findings.', requiredTools: ['inspect'], requiredCapabilities: ['analysis'] }],
    },
  });
}

function runtimeHandlers() {
  return {
    tool: async (pluginId: string, contribution: { name: string }) => async (input: Record<string, unknown>) => ({ pluginId, contribution: contribution.name, input }),
    hook: async (pluginId: string, contribution: { name: string }) => async () => ({ hookId: `plugin:${pluginId}:hook:${contribution.name}`, action: 'continue' as const }),
  };
}

test('managed plugin manifest verifies Ed25519 signature and normalizes signed policy fields', () => {
  const fresh = signingFixture({ permissions: ['skill:register', 'skill:register'], capabilities: ['analysis', 'analysis'] });
  const verified = verifyManagedManifest(fresh.manifest, fresh.trust, fresh.policy);
  assert.equal(verified.manifest.id, 'reviewer');
  assert.deepEqual(verified.manifest.permissions, ['skill:register']);
  assert.deepEqual(verified.manifest.capabilities, ['analysis']);
  assert.match(verified.manifestDigest, /^[a-f0-9]{64}$/);
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

test('plugin manager exposes contributions only while enabled and cleans up ownership on disable/uninstall', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-manager-'));
  try {
    const { manifest, trust, policy } = lifecycleFixture();
    const tools = new ToolRegistry();
    const hooks = new HookEngine();
    const agents = new AgentRegistry(false);
    const manager = new DurablePluginManager({ store: new DurablePluginStore({ directory }), trust, policy, tools, hooks, agents, handlers: runtimeHandlers() });
    await manager.init();

    const installed = await manager.install(manifest);
    assert.equal(installed.status, 'installed');
    assert.equal(tools.list().length, 0);
    assert.equal(hooks.list().length, 0);
    assert.equal(agents.list().length, 0);
    assert.throws(() => manager.resolveSkill('reviewer', 'review'), /enabled/i);

    const enabled = await manager.enable('reviewer');
    assert.equal(enabled.status, 'enabled');
    assert.equal(tools.get('plugin:reviewer:tool:inspect').source, 'plugin');
    assert.equal(hooks.list()[0]?.id, 'plugin:reviewer:hook:audit');
    assert.equal(agents.findByName('plugin:reviewer:agent:specialist')?.role, 'Plugin specialist');
    assert.equal(manager.resolveSkill('reviewer', 'review').id, 'plugin:reviewer:skill:review');

    const request = tools.request('plugin:reviewer:tool:inspect', 'ex', 'agent', { text: 'hello' });
    const result = await tools.executeAuthorized(request, async () => true) as { contribution: string };
    assert.equal(result.contribution, 'inspect');

    const disabled = await manager.disable('reviewer');
    assert.equal(disabled.status, 'disabled');
    assert.throws(() => tools.get('plugin:reviewer:tool:inspect'), /unknown tool/i);
    assert.equal(hooks.list().length, 0);
    assert.equal(agents.findByName('plugin:reviewer:agent:specialist'), undefined);
    assert.throws(() => manager.resolveSkill('reviewer', 'review'), /enabled/i);

    await manager.uninstall('reviewer');
    assert.equal(await manager.get('reviewer'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plugin manager rehydrates enabled contributions after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-restart-'));
  try {
    const { manifest, trust, policy } = lifecycleFixture();
    const first = new DurablePluginManager({
      store: new DurablePluginStore({ directory }),
      trust,
      policy,
      tools: new ToolRegistry(),
      hooks: new HookEngine(),
      agents: new AgentRegistry(false),
      handlers: runtimeHandlers(),
    });
    await first.init();
    await first.install(manifest);
    await first.enable('reviewer');

    const tools = new ToolRegistry();
    const hooks = new HookEngine();
    const agents = new AgentRegistry(false);
    const restored = new DurablePluginManager({ store: new DurablePluginStore({ directory }), trust, policy, tools, hooks, agents, handlers: runtimeHandlers() });
    await restored.init();

    assert.equal((await restored.get('reviewer'))?.status, 'enabled');
    assert.equal(tools.get('plugin:reviewer:tool:inspect').source, 'plugin');
    assert.equal(hooks.list()[0]?.id, 'plugin:reviewer:hook:audit');
    assert.ok(agents.findByName('plugin:reviewer:agent:specialist'));
    assert.equal(restored.resolveSkill('reviewer', 'review').pluginId, 'reviewer');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plugin enable rolls back partial runtime registrations when handler resolution fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-rollback-'));
  try {
    const fixture = signingFixture({
      permissions: ['tool:register'],
      contributions: {
        tools: [
          { name: 'first', description: 'First', risk: 'low', permissions: [], inputSchema: {} },
          { name: 'second', description: 'Second', risk: 'low', permissions: [], inputSchema: {} },
        ],
      },
    });
    const tools = new ToolRegistry();
    const manager = new DurablePluginManager({
      store: new DurablePluginStore({ directory }),
      trust: fixture.trust,
      policy: fixture.policy,
      tools,
      hooks: new HookEngine(),
      agents: new AgentRegistry(false),
      handlers: {
        tool: async (_pluginId: string, contribution: { name: string }) => contribution.name === 'first' ? async () => ({ ok: true }) : undefined,
        hook: async () => undefined,
      },
    });
    await manager.init();
    await manager.install(fixture.manifest);

    await assert.rejects(() => manager.enable('reviewer'), /handler/i);
    assert.equal(tools.list().length, 0);
    assert.equal((await manager.get('reviewer'))?.status, 'installed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
