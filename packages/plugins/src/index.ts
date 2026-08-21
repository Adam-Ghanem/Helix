export type PluginPermission = 'tool:register' | 'provider:register' | 'workflow:register' | 'filesystem:read' | 'filesystem:write' | 'network:egress';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  permissions: PluginPermission[];
  capabilities: string[];
  entrypoint: string;
  integrity?: string;
}

export interface PluginPolicy {
  allowedPermissions: PluginPermission[];
  allowedCapabilities?: string[];
}

export function validateManifest(manifest: PluginManifest, policy: PluginPolicy): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(manifest.id)) throw new Error('Invalid plugin id');
  if (!manifest.name || !manifest.version || !manifest.apiVersion || !manifest.entrypoint) throw new Error('Plugin manifest is incomplete');
  for (const permission of manifest.permissions) {
    if (!policy.allowedPermissions.includes(permission)) throw new Error(`Plugin permission denied: ${permission}`);
  }
  if (policy.allowedCapabilities) {
    for (const capability of manifest.capabilities) {
      if (!policy.allowedCapabilities.includes(capability)) throw new Error(`Plugin capability denied: ${capability}`);
    }
  }
}

export class PluginRegistry {
  private readonly manifests = new Map<string, PluginManifest>();

  install(manifest: PluginManifest, policy: PluginPolicy): PluginManifest {
    validateManifest(manifest, policy);
    if (this.manifests.has(manifest.id)) throw new Error(`Plugin already installed: ${manifest.id}`);
    this.manifests.set(manifest.id, { ...manifest, permissions: [...manifest.permissions], capabilities: [...manifest.capabilities] });
    return this.manifests.get(manifest.id)!;
  }

  remove(id: string): void {
    this.manifests.delete(id);
  }

  get(id: string): PluginManifest {
    const manifest = this.manifests.get(id);
    if (!manifest) throw new Error(`Unknown plugin: ${id}`);
    return manifest;
  }

  list(): PluginManifest[] {
    return [...this.manifests.values()];
  }
}
