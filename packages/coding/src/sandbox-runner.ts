import type { ExecutableSandbox } from '../../sandbox/src/index.js';
import type { BoundedProcessRequest, BoundedProcessResult, ProcessRunner } from './process.js';

export class SandboxProcessRunner implements ProcessRunner {
  readonly isolated: boolean;
  private readonly sandbox: ExecutableSandbox;

  constructor(options: { sandbox: ExecutableSandbox }) {
    this.sandbox = options.sandbox;
    this.isolated = options.sandbox.isolated;
  }

  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('timeoutMs must be greater than zero');
    if (request.signal?.aborted) throw new Error('Process execution cancelled before start');
    const result = await this.sandbox.executeRequest({
      command: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      ...(request.environment ? { environment: request.environment } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: request.timeoutMs,
    });
    return {
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled ?? false,
    };
  }
}
