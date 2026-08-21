import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import { id, timestamp } from '../../core/src/index.js';
import { validateCommand } from './policy.js';
import { SandboxBackend, SandboxCommand, SandboxPolicy, SandboxResult, SandboxSnapshot, SandboxStatus } from './types.js';

interface DockerResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; killed: boolean; }

export function buildDockerRunArgs(containerName: string, policy: SandboxPolicy): string[] {
  const network = policy.allowNetwork ? policy.networkMode : 'none';
  const args = ['create', '--name', containerName, ...(policy.readOnlyRoot ? ['--read-only'] : []), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(policy.maxProcesses), '--memory', `${policy.memoryLimitMb}m`, '--cpus', String(policy.cpuLimit), '--user', policy.user, '--workdir', '/workspace', '--mount', `type=bind,src=${policy.workspacePath},dst=/workspace,rw`, '--network', network];
  if (!policy.allowChildProcesses) args.push('--ulimit', 'nproc=1:1');
  args.push(policy.containerImage, 'sleep', 'infinity');
  return args;
}

export async function dockerAvailable(): Promise<boolean> {
  try { const result = await runDocker(['version', '--format', '{{.Server.Version}}'], 5000); return result.exitCode === 0; } catch { return false; }
}

function runDocker(args: string[], timeoutMs: number, input?: string): Promise<DockerResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let killed = false;
    const timer = setTimeout(() => { timedOut = true; killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    child.on('error', reject);
    child.on('close', (exitCode) => { clearTimeout(timer); resolvePromise({ exitCode: exitCode ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut, killed }); });
  });
}

export class DockerSandbox implements SandboxBackend {
  readonly name = 'docker';
  private readonly sandboxId = id('sandbox');
  private readonly containerName = `helix-${this.sandboxId.replaceAll('_', '-')}`;
  private readonly createdAt = timestamp();
  private currentStatus: SandboxStatus = 'creating';

  constructor(private readonly policy: SandboxPolicy) {}

  async create(): Promise<void> {
    if (!(await dockerAvailable())) throw new Error('Docker daemon is unavailable');
    const result = await runDocker(buildDockerRunArgs(this.containerName, this.policy), this.policy.timeoutMs);
    if (result.exitCode !== 0) { this.currentStatus = 'failed'; throw new Error(`Docker create failed: ${result.stderr.trim()}`); }
    this.currentStatus = 'stopped';
  }

  async start(): Promise<void> {
    if (this.currentStatus === 'creating') await this.create();
    const result = await runDocker(['start', this.containerName], this.policy.timeoutMs);
    if (result.exitCode !== 0) { this.currentStatus = 'failed'; throw new Error(`Docker start failed: ${result.stderr.trim()}`); }
    this.currentStatus = 'running';
  }

  async exec(command: SandboxCommand): Promise<SandboxResult> {
    if (this.currentStatus !== 'running') throw new Error(`Sandbox is not running: ${this.currentStatus}`);
    const checked = await validateCommand(command, this.policy);
    const workspaceRelative = relative(this.policy.workspacePath, checked.cwd);
    const containerCwd = workspaceRelative ? `/workspace/${workspaceRelative}` : '/workspace';
    const envArgs = Object.entries(checked.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const started = Date.now();
    const timeoutMs = Math.min(checked.timeoutMs ?? this.policy.timeoutMs, this.policy.timeoutMs);
    const result = await runDocker(['exec', '-i', '--workdir', containerCwd, ...envArgs, this.containerName, checked.command, ...checked.args], timeoutMs, checked.stdin);
    if (result.timedOut || result.killed) await runDocker(['kill', this.containerName], 5000);
    const durationMs = Date.now() - started;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs, timedOut: result.timedOut, killed: result.killed, sandboxId: this.sandboxId, auditId: id('audit'), resourceUsage: { durationMs, memoryLimitMb: this.policy.memoryLimitMb, cpuLimit: this.policy.cpuLimit, maxProcesses: this.policy.maxProcesses, networkMode: this.policy.allowNetwork ? this.policy.networkMode : 'none' } };
  }

  async stop(): Promise<void> { if (this.currentStatus === 'running' || this.currentStatus === 'failed') { await runDocker(['stop', '--time', '1', this.containerName], this.policy.timeoutMs); this.currentStatus = 'stopped'; } }
  async destroy(): Promise<void> { await runDocker(['rm', '--force', this.containerName], this.policy.timeoutMs); this.currentStatus = 'destroyed'; }
  status(): SandboxStatus { return this.currentStatus; }
  snapshot(): SandboxSnapshot { return { sandboxId: this.sandboxId, status: this.currentStatus, policy: structuredClone(this.policy), createdAt: this.createdAt, backend: this.name }; }
}
