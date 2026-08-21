import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
  assign(subject: string, role: SecurityRole): void { this.roles.set(subject, role); }
  can(subject: string, permission: SecurityPermission): boolean { const role = this.roles.get(subject); return role ? ROLE_PERMISSIONS[role].includes(permission) : false; }
  role(subject: string): SecurityRole | undefined { return this.roles.get(subject); }
}

export interface SecretRecord { id: string; name: string; digest: string; createdAt: string; }

export class MemorySecretVault {
  private readonly values = new Map<string, { value: string; record: SecretRecord }>();
  put(name: string, value: string): SecretRecord {
    if (!name || !value) throw new Error('Secret name and value are required');
    const record = { id: `secret_${randomUUID()}`, name, digest: createHash('sha256').update(value).digest('hex'), createdAt: new Date().toISOString() };
    this.values.set(name, { value, record });
    return record;
  }
  get(name: string): string { const entry = this.values.get(name); if (!entry) throw new Error(`Unknown secret: ${name}`); return entry.value; }
  metadata(): SecretRecord[] { return [...this.values.values()].map(({ record }) => ({ ...record })); }
}

export function validatePath(candidate: string, allowedRoots: string[]): string {
  if (!candidate || !allowedRoots.length) throw new Error('A path and at least one allowed root are required');
  const normalized = normalize(resolve(candidate));
  const allowed = allowedRoots.some((root) => { const rootPath = normalize(resolve(root)); const remainder = relative(rootPath, normalized); return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder)); });
  if (!allowed) throw new Error('Path escapes all allowed roots (escapes allowed root)');
  return normalized;
}

export function assertAbsoluteExecutable(command: string, allowedExecutables: string[]): string {
  if (!isAbsolute(command)) throw new Error('Executable must be an absolute path');
  const normalized = normalize(command);
  if (!allowedExecutables.map(normalize).includes(normalized)) throw new Error('Executable is not allowlisted');
  return normalized;
}

export class PathValidator {
  constructor(private readonly root: string) {}
  resolve(candidate: string): string { return validatePath(resolve(this.root, candidate), [this.root]); }
}

export interface SafeExecutionOptions { cwd: string; allowedCommands: string[]; timeoutMs?: number; environment?: Record<string, string>; allowedEnvironmentKeys?: string[]; }
export interface SafeExecutionResult { command: string; args: string[]; exitCode: number; stdout: string; stderr: string; timedOut: boolean; }

export class SafeExecutor {
  constructor(private readonly paths: PathValidator) {}
  run(command: string, args: string[], options: SafeExecutionOptions): Promise<SafeExecutionResult> {
    if (!options.allowedCommands.includes(command)) return Promise.reject(new Error(`Command is not allowlisted: ${command}`));
    const cwd = this.paths.resolve(options.cwd);
    const allowedKeys = new Set(options.allowedEnvironmentKeys ?? []);
    const environment = Object.fromEntries(Object.entries(options.environment ?? {}).filter(([key]) => allowedKeys.has(key)));
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? '', ...environment }, shell: false });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (exitCode) => { clearTimeout(timer); resolvePromise({ command, args: [...args], exitCode: exitCode ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut }); });
    });
  }
}
