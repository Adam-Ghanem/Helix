import { spawn } from 'node:child_process';
import { id, timestamp } from '../../core/src/index.js';
import { validateCommand } from './policy.js';
import { SandboxBackend, SandboxCommand, SandboxPolicy, SandboxResult, SandboxSnapshot, SandboxStatus, defaultSandboxPolicy } from './types.js';

export class LocalSandbox implements SandboxBackend {
  readonly name = 'local';
  private readonly sandboxId = id('sandbox');
  private readonly createdAt = timestamp();
  private currentStatus: SandboxStatus = 'creating';
  private readonly running = new Set<number>();

  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy | { workspace: string; allowedCommands: string[]; timeoutMs?: number }) {
    if ('workspace' in policy) {
      const defaults = defaultSandboxPolicy(policy.workspace);
      this.policy = { ...defaults, allowedExecutables: [...policy.allowedCommands], ...(policy.timeoutMs ? { timeoutMs: policy.timeoutMs } : {}) };
    } else {
      this.policy = structuredClone(policy);
    }
  }

  async create(): Promise<void> { this.currentStatus = 'ready'; }
  async start(): Promise<void> { if (this.currentStatus === 'creating') await this.create(); if (this.currentStatus !== 'ready' && this.currentStatus !== 'stopped') throw new Error(`Cannot start sandbox from ${this.currentStatus}`); this.currentStatus = 'running'; }

  async exec(command: SandboxCommand): Promise<SandboxResult> {
    if (this.currentStatus !== 'running') throw new Error(`Sandbox is not running: ${this.currentStatus}`);
    const checked = await validateCommand(command, this.policy);
    const started = Date.now();
    const timeoutMs = Math.min(checked.timeoutMs ?? this.policy.timeoutMs, this.policy.timeoutMs);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(checked.command, checked.args, { cwd: checked.cwd, env: { PATH: process.env.PATH ?? '', ...checked.env }, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid) this.running.add(child.pid);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let killed = false;
      const timer = setTimeout(() => { timedOut = true; killed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      if (checked.stdin !== undefined) child.stdin.end(checked.stdin); else child.stdin.end();
      child.on('error', reject);
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (child.pid) this.running.delete(child.pid);
        resolvePromise({ exitCode: exitCode ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), durationMs: Date.now() - started, timedOut, killed, sandboxId: this.sandboxId, resourceUsage: { durationMs: Date.now() - started, memoryLimitMb: this.policy.memoryLimitMb, cpuLimit: this.policy.cpuLimit, maxProcesses: this.policy.maxProcesses, networkMode: this.policy.networkMode }, auditId: id('audit'), limitations: ['local backend cannot enforce cgroup memory/CPU/PID limits', 'local backend cannot provide kernel-level filesystem or network isolation'] });
      });
    });
  }

  async execute(command: string, args: string[], cwd = '.', env: Record<string, string> = {}): Promise<SandboxResult> {
    if (this.currentStatus === 'creating' || this.currentStatus === 'ready' || this.currentStatus === 'stopped') await this.start();
    return this.exec({ command, args, cwd, env });
  }

  async stop(): Promise<void> { for (const pid of this.running) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ } } this.running.clear(); this.currentStatus = 'stopped'; }
  async destroy(): Promise<void> { await this.stop(); this.currentStatus = 'destroyed'; }
  status(): SandboxStatus { return this.currentStatus; }
  snapshot(): SandboxSnapshot { return { sandboxId: this.sandboxId, status: this.currentStatus, policy: structuredClone(this.policy), createdAt: this.createdAt, backend: this.name }; }
}
