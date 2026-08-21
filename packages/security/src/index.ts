import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

export type SecurityRole = 'viewer' | 'operator' | 'developer' | 'admin';
export type SecurityPermission = 'execution:read' | 'execution:write' | 'tool:request' | 'approval:decide' | 'plugin:install' | 'secret:read';

const ROLE_PERMISSIONS: Record<SecurityRole, SecurityPermission[]> = {
  viewer: ['execution:read'],
  operator: ['execution:read', 'execution:write', 'tool:request'],
  developer: ['execution:read', 'execution:write', 'tool:request', 'approval:decide'],
  admin: ['execution:read', 'execution:write', 'tool:request', 'approval:decide', 'plugin:install', 'secret:read'],
};

export class RolePolicy {
  constructor(private readonly roles: Map<string, SecurityRole> = new Map()) {}

  assign(subject: string, role: SecurityRole): void {
    this.roles.set(subject, role);
  }

  can(subject: string, permission: SecurityPermission): boolean {
    const role = this.roles.get(subject);
    return role ? ROLE_PERMISSIONS[role].includes(permission) : false;
  }

  role(subject: string): SecurityRole | undefined {
    return this.roles.get(subject);
  }
}

export interface SecretRecord {
  id: string;
  name: string;
  digest: string;
  createdAt: string;
}

export class MemorySecretVault {
  private readonly values = new Map<string, { value: string; record: SecretRecord }>();

  put(name: string, value: string): SecretRecord {
    if (!name || !value) throw new Error('Secret name and value are required');
    const record: SecretRecord = {
      id: `secret_${randomUUID()}`,
      name,
      digest: createHash('sha256').update(value).digest('hex'),
      createdAt: new Date().toISOString(),
    };
    this.values.set(name, { value, record });
    return record;
  }

  get(name: string): string {
    const entry = this.values.get(name);
    if (!entry) throw new Error(`Unknown secret: ${name}`);
    return entry.value;
  }

  metadata(): SecretRecord[] {
    return [...this.values.values()].map(({ record }) => record);
  }
}

export function validatePath(candidate: string, allowedRoots: string[]): string {
  if (!candidate || !allowedRoots.length) throw new Error('A path and at least one allowed root are required');
  const resolved = resolve(candidate);
  const normalized = normalize(resolved);
  const allowed = allowedRoots.some((root) => {
    const rootPath = resolve(root);
    return normalized === rootPath || !relative(rootPath, normalized).startsWith('..');
  });
  if (!allowed) throw new Error('Path escapes all allowed roots');
  return normalized;
}

export function assertAbsoluteExecutable(command: string, allowedExecutables: string[]): string {
  if (!isAbsolute(command)) throw new Error('Executable must be an absolute path');
  const normalized = normalize(command);
  if (!allowedExecutables.map(normalize).includes(normalized)) throw new Error('Executable is not allowlisted');
  return normalized;
}
