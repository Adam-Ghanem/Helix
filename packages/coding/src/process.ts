import { spawn } from 'node:child_process';
import { assertAbsoluteExecutable, validatePath } from '../../security/src/index.js';

export interface BoundedProcessRunnerOptions {
  allowedExecutables: string[];
  workspaceRoots: string[];
  environmentKeys: string[];
  maxStdoutBytes: number;
  maxStderrBytes: number;
  killGraceMs?: number;
}

export interface BoundedProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  environment?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BoundedProcessResult {
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ProcessRunner {
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
}

export class BoundedProcessRunner implements ProcessRunner {
  private readonly options: Required<BoundedProcessRunnerOptions>;

  constructor(options: BoundedProcessRunnerOptions) {
    if (!options.allowedExecutables.length) throw new Error('At least one executable must be allowlisted');
    if (!options.workspaceRoots.length) throw new Error('At least one workspace root is required');
    if (!Number.isInteger(options.maxStdoutBytes) || options.maxStdoutBytes < 1) throw new Error('maxStdoutBytes must be positive');
    if (!Number.isInteger(options.maxStderrBytes) || options.maxStderrBytes < 1) throw new Error('maxStderrBytes must be positive');
    this.options = { ...options, killGraceMs: options.killGraceMs ?? 250 };
  }

  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    const executable = assertAbsoluteExecutable(request.executable, this.options.allowedExecutables);
    const cwd = validatePath(request.cwd, this.options.workspaceRoots);
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('timeoutMs must be greater than zero');
    if (request.signal?.aborted) throw new Error('Process execution cancelled before start');
    const allowedEnvironment = new Set(this.options.environmentKeys);
    const environment = Object.fromEntries(Object.entries(request.environment ?? {}).filter(([key]) => allowedEnvironment.has(key)));

    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...request.args], { cwd, env: { PATH: process.env.PATH ?? '', ...environment }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const append = (target: Buffer[], chunk: Buffer, currentBytes: number, maxBytes: number): { bytes: number; truncated: boolean } => {
        const remaining = Math.max(0, maxBytes - currentBytes);
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        return { bytes: currentBytes + Math.min(chunk.length, remaining), truncated: chunk.length > remaining };
      };
      child.stdout.on('data', (chunk: Buffer) => { const next = append(stdout, chunk, stdoutBytes, this.options.maxStdoutBytes); stdoutBytes = next.bytes; stdoutTruncated ||= next.truncated; });
      child.stderr.on('data', (chunk: Buffer) => { const next = append(stderr, chunk, stderrBytes, this.options.maxStderrBytes); stderrBytes = next.bytes; stderrTruncated ||= next.truncated; });

      const terminate = () => {
        if (child.exitCode !== null || child.killed) return;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, this.options.killGraceMs);
      };
      const timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, request.timeoutMs);
      const onAbort = () => { cancelled = true; terminate(); };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', onAbort);
        resolve({ executable, args: [...request.args], cwd, exitCode: exitCode ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), stdoutTruncated, stderrTruncated, timedOut, cancelled });
      });
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
  }
}
