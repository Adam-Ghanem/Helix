import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { id, timestamp } from '../../core/src/index.js';
import { SandboxCommand, SandboxPolicy, SandboxResult, SandboxStatus } from './types.js';

export interface SandboxAuditRecord {
  auditId: string;
  sandboxId: string;
  executionId?: string;
  agentId?: string;
  operation: 'create' | 'start' | 'exec' | 'stop' | 'destroy';
  command?: string;
  executable?: string;
  policy: Omit<SandboxPolicy, 'environmentAllowlist'> & { environmentKeys: string[] };
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  timedOut?: boolean;
  killed?: boolean;
  resourceUsage?: SandboxResult['resourceUsage'];
  backend: string;
  status: SandboxStatus;
}

export class SandboxAuditLog {
  private readonly records: SandboxAuditRecord[] = [];
  constructor(private readonly file?: string) {}

  async init(): Promise<void> {
    if (!this.file) return;
    try {
      const contents = await readFile(this.file, 'utf8');
      this.records.push(...contents.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SandboxAuditRecord));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async record(input: { sandboxId: string; executionId?: string; agentId?: string; operation: SandboxAuditRecord['operation']; command?: SandboxCommand; result?: SandboxResult; policy: SandboxPolicy; backend: string; status: SandboxStatus; startedAt: string }): Promise<SandboxAuditRecord> {
    const endedAt = timestamp();
    const audit: SandboxAuditRecord = {
      auditId: id('audit'), sandboxId: input.sandboxId, ...(input.executionId ? { executionId: input.executionId } : {}), ...(input.agentId ? { agentId: input.agentId } : {}), operation: input.operation,
      ...(input.command ? { command: input.command.command, executable: input.command.command } : {}),
      policy: (() => { const { environmentAllowlist, ...safePolicy } = input.policy; return { ...safePolicy, environmentKeys: [...environmentAllowlist] }; })(),
      startedAt: input.startedAt, endedAt, ...(input.result ? { exitCode: input.result.exitCode, timedOut: input.result.timedOut, killed: input.result.killed, resourceUsage: input.result.resourceUsage } : {}), backend: input.backend, status: input.status,
    };
    this.records.push(audit);
    if (this.file) { await mkdir(dirname(this.file), { recursive: true }); await appendFile(this.file, `${JSON.stringify(audit)}\n`, 'utf8'); }
    return structuredClone(audit);
  }

  list(sandboxId?: string): SandboxAuditRecord[] { return this.records.filter((record) => !sandboxId || record.sandboxId === sandboxId).map((record) => structuredClone(record)); }
}
