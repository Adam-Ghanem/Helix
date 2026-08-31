import { createHash } from 'node:crypto';

export type PluginPermission = 'tool:register' | 'provider:register' | 'workflow:register' | 'filesystem:read' | 'filesystem:write' | 'network:egress' | string;

export interface PluginManifest {
  id?: string;
  name: string;
  version: string;
  apiVersion?: string;
  permissions: PluginPermission[];
  capabilities?: string[];
  tools?: string[];
  entrypoint: string;
  integrity?: string;
  signature?: string;
}

export interface PluginPolicy {
  allowedPermissions: PluginPermission[];
  allowedCapabilities?: string[];
}

export interface PluginRecord {
  manifest: PluginManifest;
  digest: string;
  status: 'registered' | 'rejected';
  reason?: string;
}

export function validateManifest(manifest: PluginManifest, policy: PluginPolicy): void {
  if (manifest.id && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(manifest.id)) throw new Error('Invalid plugin id');
  if (!manifest.name || !manifest.version || !manifest.entrypoint) throw new Error('Plugin manifest is incomplete');
  if (manifest.id && !manifest.apiVersion) throw new Error('Plugin manifest is incomplete');
  for (const permission of manifest.permissions) if (!policy.allowedPermissions.includes(permission)) throw new Error(`Plugin permission denied: ${permission}`);
  if (policy.allowedCapabilities) for (const capability of manifest.capabilities ?? []) if (!policy.allowedCapabilities.includes(capability)) throw new Error(`Plugin capability denied: ${capability}`);
}

export class PluginRegistry {
  private readonly manifests = new Map<string, PluginManifest>();
  private readonly plugins = new Map<string, PluginRecord>();

  install(manifest: PluginManifest, policy: PluginPolicy): PluginManifest {
    validateManifest(manifest, policy);
    const key = manifest.id ?? manifest.name;
    if (this.manifests.has(key) || this.plugins.has(key)) throw new Error(`Plugin already installed: ${key}`);
    const stored = { ...manifest, permissions: [...new Set(manifest.permissions)], ...(manifest.capabilities ? { capabilities: [...new Set(manifest.capabilities)] } : {}), ...(manifest.tools ? { tools: [...new Set(manifest.tools)] } : {}) };
    this.manifests.set(key, stored);
    return structuredClone(stored);
  }

  register(manifest: PluginManifest, trustedSignatures: string[] = []): PluginRecord {
    const digest = this.digest(manifest);
    const trusted = !manifest.signature || trustedSignatures.includes(manifest.signature);
    const key = manifest.id ?? manifest.name;
    const record: PluginRecord = { manifest: { ...manifest, permissions: [...new Set(manifest.permissions)], ...(manifest.capabilities ? { capabilities: [...new Set(manifest.capabilities)] } : {}), ...(manifest.tools ? { tools: [...new Set(manifest.tools)] } : {}) }, digest, status: trusted ? 'registered' : 'rejected', ...(trusted ? {} : { reason: 'signature is not trusted' }) };
    this.plugins.set(key, record);
    if (!trusted) throw new Error(`Plugin signature rejected: ${key}; signature is not trusted`);
    return structuredClone(record);
  }

  remove(id: string): void { this.manifests.delete(id); this.plugins.delete(id); }

  get(id: string): PluginManifest | PluginRecord {
    const manifest = this.manifests.get(id);
    if (manifest) return structuredClone(manifest);
    const plugin = this.plugins.get(id);
    if (plugin) return structuredClone(plugin);
    throw new Error(`Unknown plugin: ${id}`);
  }

  list(): Array<PluginManifest | PluginRecord> {
    const entries: Array<PluginManifest | PluginRecord> = [...this.manifests.values()].map((manifest) => structuredClone(manifest));
    entries.push(...[...this.plugins.values()].map((plugin) => structuredClone(plugin)));
    return entries;
  }

  authorize(id: string, permission: string): boolean {
    const manifest = this.manifests.get(id);
    if (manifest) return manifest.permissions.includes(permission);
    const plugin = this.plugins.get(id);
    return Boolean(plugin?.status === 'registered' && plugin.manifest.permissions.includes(permission));
  }

  private digest(manifest: PluginManifest): string {
    const canonical = JSON.stringify({ id: manifest.id ?? manifest.name, name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion ?? 'v1', entrypoint: manifest.entrypoint, permissions: [...manifest.permissions].sort(), capabilities: [...(manifest.capabilities ?? [])].sort(), tools: [...(manifest.tools ?? [])].sort() });
    return createHash('sha256').update(canonical).digest('hex');
  }
}

export * from './manifest.js';
export * from './store.js';
export * from './artifacts.js';
export * from './manager.js';
