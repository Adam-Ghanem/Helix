import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AgentRegistry } from '../../../packages/agents/src/index.js';
import { HookEngine } from '../../../packages/hooks/src/index.js';
import {
  DurablePluginManager,
  DurablePluginStore,
  PluginArtifactStore,
  PluginWorkerManager,
  StrictPluginWorkerSandboxFactory,
  type ManagedPluginManifest,
  type PluginInstallPolicy,
  type PluginTrustStore,
  type PluginWorkerRuntime,
} from '../../../packages/plugins/src/index.js';
import { ToolRegistry } from '../../../packages/tools/src/index.js';

export async function handlePluginCommand(args: string[], dataDirectory: string): Promise<unknown> {
  const manager = await createCliPluginManager(dataDirectory);
  const action = args[1] ?? 'list';

  if (action === 'list') return { plugins: await manager.list() };
  if (action === 'inspect') {
    const id = requireId(args[2], 'inspect');
    const record = await manager.get(id);
    if (!record) throw new Error(`Unknown plugin: ${id}`);
    return record;
  }
  if (action === 'install') {
    const path = args[2];
    if (!path) throw new Error('Usage: helix plugins install <manifest.json>');
    const manifestPath = resolve(path);
    const manifest = await readManagedManifest(manifestPath);
    const artifactSource = hasExecutableContributions(manifest)
      ? resolve(dirname(manifestPath), manifest.entrypoint)
      : undefined;
    return manager.install(manifest, artifactSource);
  }
  if (action === 'enable') return manager.enable(requireId(args[2], 'enable'));
  if (action === 'disable') return manager.disable(requireId(args[2], 'disable'));
  if (action === 'remove') {
    const id = requireId(args[2], 'remove');
    await manager.uninstall(id);
    return { id, removed: true };
  }
  throw new Error('Usage: helix plugins <list|inspect|install|enable|disable|remove> ...');
}

async function createCliPluginManager(dataDirectory: string): Promise<DurablePluginManager> {
  const trust: PluginTrustStore = { keys: parseTrustKeys(process.env.HELIX_PLUGIN_TRUST_KEYS) };
  const policy: PluginInstallPolicy = {
    allowedPermissions: parseCsv(process.env.HELIX_PLUGIN_ALLOWED_PERMISSIONS),
    allowedCapabilities: parseCsv(process.env.HELIX_PLUGIN_ALLOWED_CAPABILITIES),
    allowedApiVersions: parseCsv(process.env.HELIX_PLUGIN_ALLOWED_API_VERSIONS),
    maxContributionsPerKind: 64,
  };
  const nodeExecutable = pluginNodeExecutable();
  const bwrapExecutable = optionalAbsoluteExecutable(process.env.HELIX_PLUGIN_BWRAP_EXECUTABLE, 'HELIX_PLUGIN_BWRAP_EXECUTABLE');
  const artifacts = new PluginArtifactStore({ directory: join(dataDirectory, 'plugins-artifacts') });
  const workers = new PluginWorkerManager({
    artifacts,
    sandboxFactory: new StrictPluginWorkerSandboxFactory({
      workspaceRoot: resolve(join(dataDirectory, 'plugin-workspaces')),
      ...(bwrapExecutable ? { bwrapExecutable } : {}),
    }),
    nodeExecutable,
  });
  const preflightRuntime: PluginWorkerRuntime = {
    start: (pluginId, manifest, artifact) => workers.preflight(pluginId, manifest, artifact),
    callTool: async (pluginId) => { throw new Error(`CLI plugin worker is preflight-only and does not retain tool sessions: ${pluginId}`); },
    callHook: async (pluginId) => { throw new Error(`CLI plugin worker is preflight-only and does not retain hook sessions: ${pluginId}`); },
    stop: async () => undefined,
  };
  const manager = new DurablePluginManager({
    store: new DurablePluginStore({ directory: join(dataDirectory, 'plugins') }),
    trust,
    policy,
    tools: new ToolRegistry(),
    hooks: new HookEngine(),
    agents: new AgentRegistry(false),
    artifacts,
    workers: preflightRuntime,
  });
  await manager.init();
  return manager;
}

async function readManagedManifest(path: string): Promise<ManagedPluginManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Invalid plugin manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('Invalid plugin manifest: root must be a JSON object');
  assertString(parsed, 'id');
  assertString(parsed, 'name');
  assertString(parsed, 'version');
  assertString(parsed, 'apiVersion');
  assertString(parsed, 'entrypoint');
  assertString(parsed, 'artifactDigest');
  assertString(parsed, 'signerKeyId');
  assertString(parsed, 'signature');
  if (!Array.isArray(parsed.permissions) || !parsed.permissions.every((value) => typeof value === 'string')) {
    throw new Error('Invalid plugin manifest: permissions must be a string array');
  }
  if (parsed.capabilities !== undefined && (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every((value) => typeof value === 'string'))) {
    throw new Error('Invalid plugin manifest: capabilities must be a string array');
  }
  if (parsed.contributions !== undefined && !isRecord(parsed.contributions)) {
    throw new Error('Invalid plugin manifest: contributions must be an object');
  }
  return parsed as unknown as ManagedPluginManifest;
}

function pluginNodeExecutable(): string {
  const configured = process.env.HELIX_PLUGIN_NODE_EXECUTABLE;
  if (configured !== undefined) {
    if (!configured.trim() || !isAbsolute(configured)) throw new Error('HELIX_PLUGIN_NODE_EXECUTABLE must be an absolute executable path');
    return resolve(configured);
  }
  if (!isAbsolute(process.execPath)) throw new Error('Current Node executable path is not absolute');
  return resolve(process.execPath);
}

function optionalAbsoluteExecutable(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || !isAbsolute(value)) throw new Error(`${name} must be an absolute executable path`);
  return resolve(value);
}

function hasExecutableContributions(manifest: ManagedPluginManifest): boolean {
  return (manifest.contributions?.tools?.length ?? 0) > 0 || (manifest.contributions?.hooks?.length ?? 0) > 0;
}

function parseTrustKeys(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid HELIX_PLUGIN_TRUST_KEYS: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('Invalid HELIX_PLUGIN_TRUST_KEYS: expected a JSON object mapping key IDs to PEM public keys');
  const entries = Object.entries(parsed);
  if (!entries.every(([key, value]) => Boolean(key.trim()) && typeof value === 'string' && Boolean(value.trim()))) {
    throw new Error('Invalid HELIX_PLUGIN_TRUST_KEYS: every key ID and PEM public key must be a non-empty string');
  }
  return Object.fromEntries(entries.map(([key, value]) => [key.trim(), (value as string).trim()]));
}

function parseCsv(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
}

function requireId(value: string | undefined, action: string): string {
  if (!value?.trim()) throw new Error(`Usage: helix plugins ${action} <id>`);
  return value;
}

function assertString(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== 'string' || !(record[field] as string).trim()) {
    throw new Error(`Invalid plugin manifest: ${field} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
