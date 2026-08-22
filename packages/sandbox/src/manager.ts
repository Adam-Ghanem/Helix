import { join } from 'node:path';
import { DockerSandbox } from './docker.js';
import { SandboxAuditLog } from './audit.js';
import { LocalSandbox } from './local.js';
import { validateCommand } from './policy.js';
import { SandboxBackend, SandboxCommand, SandboxPolicy, SandboxResult, SandboxSnapshot, SandboxStatus } from './types.js';

export interface SandboxCreateOptions {
  policy: SandboxPolicy;
  backend?: 'local' | 'docker';
  executionId?: string;
  agentId?: string;
}

interface ManagedSandbox {
  backend: SandboxBackend;
  policy: SandboxPolicy;
  executionId?: string;
  agentId?: string;
}

export class SandboxManager {
  readonly audit: SandboxAuditLog;
  private readonly sandboxes = new Map<string, ManagedSandbox>();

  constructor(options: { auditFile?: string } = {}) { this.audit = new SandboxAuditLog(options.auditFile); }
  async init(): Promise<void> { await this.audit.init(); }

  async create(options: SandboxCreateOptions): Promise<SandboxSnapshot> {
    const backend = options.backend === 'docker' ? new DockerSandbox(options.policy) : new LocalSandbox(options.policy);
    const startedAt = new Date().toISOString();
    const managed = { backend, policy: options.policy, ...(options.executionId ? { executionId: options.executionId } : {}), ...(options.agentId ? { agentId: options.agentId } : {}) };
    this.sandboxes.set(backend.snapshot().sandboxId, managed);
    try {
      await backend.create();
      await this.record(managed, 'create', startedAt);
      return backend.snapshot();
    } catch (error) {
      await this.record(managed, 'create', startedAt);
      throw error;
    }
  }

  async start(sandboxId: string): Promise<SandboxSnapshot> { const managed = this.require(sandboxId); const startedAt = new Date().toISOString(); try { await managed.backend.start(); } catch (error) { await this.record(managed, 'start', startedAt); throw error; } await this.record(managed, 'start', startedAt); return managed.backend.snapshot(); }

  async exec(sandboxId: string, command: SandboxCommand): Promise<SandboxResult> {
    const managed = this.require(sandboxId);
    const startedAt = new Date().toISOString();
    let checked: SandboxCommand;
    try {
      checked = await validateCommand(command, managed.policy);
    } catch (error) {
      await this.record(managed, 'exec', startedAt, command);
      throw error;
    }
    let result: SandboxResult;
    try { result = await managed.backend.exec(checked); } catch (error) { await this.record(managed, 'exec', startedAt, checked); throw error; }
    const audit = await this.record(managed, 'exec', startedAt, checked, result);
    result.auditId = audit.auditId;
    return result;
  }

  async stop(sandboxId: string): Promise<SandboxSnapshot> { const managed = this.require(sandboxId); const startedAt = new Date().toISOString(); try { await managed.backend.stop(); } catch (error) { await this.record(managed, 'stop', startedAt); throw error; } await this.record(managed, 'stop', startedAt); return managed.backend.snapshot(); }

  async destroy(sandboxId: string): Promise<SandboxSnapshot> { const managed = this.require(sandboxId); const startedAt = new Date().toISOString(); try { await managed.backend.destroy(); } catch (error) { await this.record(managed, 'destroy', startedAt); throw error; } await this.record(managed, 'destroy', startedAt); return managed.backend.snapshot(); }

  status(sandboxId: string): SandboxSnapshot { return this.require(sandboxId).backend.snapshot(); }
  list(): SandboxSnapshot[] { return [...this.sandboxes.values()].map(({ backend }) => backend.snapshot()); }
  audits(sandboxId?: string) { return this.audit.list(sandboxId); }

  private async record(managed: ManagedSandbox, operation: 'create' | 'start' | 'exec' | 'stop' | 'destroy', startedAt: string, command?: SandboxCommand, result?: SandboxResult) {
    return this.audit.record({ sandboxId: managed.backend.snapshot().sandboxId, ...(managed.executionId ? { executionId: managed.executionId } : {}), ...(managed.agentId ? { agentId: managed.agentId } : {}), operation, ...(command ? { command } : {}), ...(result ? { result } : {}), policy: managed.policy, backend: managed.backend.name, status: managed.backend.status(), startedAt });
  }

  private require(sandboxId: string): ManagedSandbox { const managed = this.sandboxes.get(sandboxId); if (!managed) throw new Error(`Unknown sandbox: ${sandboxId}`); return managed; }
}

export function defaultAuditFile(dataDirectory: string): string { return join(dataDirectory, 'helix.sandbox.audit.jsonl'); }
