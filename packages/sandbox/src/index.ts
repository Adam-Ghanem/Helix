import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { PathValidator, SafeExecutionOptions, SafeExecutionResult, SafeExecutor, assertAbsoluteExecutable, validatePath } from '../../security/src/index.js';

export interface SandboxOptions {
  workspace: string;
  allowedCommands: string[];
  timeoutMs?: number;
}

/**
 * Backward-compatible policy-only sandbox. This is intentionally NOT reported
 * as OS isolation. New untrusted execution should use SandboxManager instead.
 */
export class LocalSandbox {
  readonly security: PathValidator;
  private readonly executor: SafeExecutor;

  constructor(private readonly options: SandboxOptions) {
    this.security = new PathValidator(options.workspace);
    this.executor = new SafeExecutor(this.security);
  }

  execute(command: string, args: string[], cwd = '.', environment: Record<string, string> = {}): Promise<SafeExecutionResult> {
    const execution: SafeExecutionOptions = { cwd, allowedCommands: this.options.allowedCommands, ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}), environment, allowedEnvironmentKeys: [] };
    return this.executor.run(command, args, execution);
  }

  note(): string {
    return 'LocalSandbox provides path and command policy controls only; it is not OS/container isolation.';
  }
}

export type SandboxBackend = 'bubblewrap' | 'process';

export interface StrictSandboxOptions {
  workspace: string;
  allowedCommands: string[];
  allowedEnvironmentKeys?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxExecutionPlan {
  backend: SandboxBackend;
  isolated: boolean;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SandboxExecutionResult {
  backend: SandboxBackend;
  isolated: boolean;
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ExecutableSandbox {
  readonly backend: SandboxBackend;
  readonly isolated: boolean;
  execute(command: string, args: string[], cwd?: string, environment?: Record<string, string>): Promise<SandboxExecutionResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

abstract class BaseSandbox implements ExecutableSandbox {
  abstract readonly backend: SandboxBackend;
  abstract readonly isolated: boolean;
  protected readonly workspace: string;
  protected readonly allowedCommands: string[];
  protected readonly allowedEnvironmentKeys: Set<string>;
  protected readonly timeoutMs: number;
  protected readonly maxOutputBytes: number;

  constructor(options: StrictSandboxOptions) {
    this.workspace = resolve(options.workspace);
    this.allowedCommands = options.allowedCommands.map((command) => {
      if (!isAbsolute(command)) throw new Error(`Sandbox allowed command must be absolute: ${command}`);
      return resolve(command);
    });
    if (!this.allowedCommands.length) throw new Error('Sandbox requires at least one allowed command');
    this.allowedEnvironmentKeys = new Set(options.allowedEnvironmentKeys ?? []);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
  }

  abstract execute(command: string, args: string[], cwd?: string, environment?: Record<string, string>): Promise<SandboxExecutionResult>;

  protected validateCommand(command: string): string {
    return assertAbsoluteExecutable(command, this.allowedCommands);
  }

  protected resolveCwd(cwd: string): string {
    return validatePath(resolve(this.workspace, cwd), [this.workspace]);
  }

  protected filterEnvironment(environment: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(environment).filter(([key]) => this.allowedEnvironmentKeys.has(key)));
  }
}

export class UnsafeProcessSandbox extends BaseSandbox {
  readonly backend = 'process' as const;
  readonly isolated = false;

  async execute(command: string, args: string[], cwd = '.', environment: Record<string, string> = {}): Promise<SandboxExecutionResult> {
    const executable = this.validateCommand(command);
    const hostCwd = this.resolveCwd(cwd);
    const filtered = this.filterEnvironment(environment);
    const result = await runBounded({
      executable,
      args: [...args],
      cwd: hostCwd,
      environment: { PATH: process.env.PATH ?? SAFE_PATH, ...filtered },
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    return { backend: this.backend, isolated: this.isolated, command: executable, args: [...args], ...result };
  }
}

export interface BubblewrapSandboxOptions extends StrictSandboxOptions {
  bwrapExecutable: string;
  prlimitExecutable?: string;
  runtimeReadOnlyPaths?: string[];
  network?: boolean;
  memoryMb?: number;
  cpuSeconds?: number;
  maxProcesses?: number;
}

export class BubblewrapSandbox extends BaseSandbox {
  readonly backend = 'bubblewrap' as const;
  readonly isolated = true;
  private readonly bwrapExecutable: string;
  private readonly prlimitExecutable: string | undefined;
  private readonly runtimeReadOnlyPaths: string[];
  private readonly network: boolean;
  private readonly memoryMb: number;
  private readonly cpuSeconds: number;
  private readonly maxProcesses: number;

  constructor(options: BubblewrapSandboxOptions) {
    super(options);
    this.bwrapExecutable = absoluteExecutable(options.bwrapExecutable, 'bwrapExecutable');
    this.prlimitExecutable = options.prlimitExecutable ? absoluteExecutable(options.prlimitExecutable, 'prlimitExecutable') : undefined;
    this.runtimeReadOnlyPaths = [...new Set(options.runtimeReadOnlyPaths ?? ['/usr', '/bin', '/lib', '/lib64'])].map((path) => {
      if (!isAbsolute(path)) throw new Error(`Sandbox runtime path must be absolute: ${path}`);
      if (path === '/' || path.startsWith('/home') || path.startsWith('/root')) throw new Error(`Sandbox runtime path is too broad or private: ${path}`);
      return resolve(path);
    });
    if (!this.runtimeReadOnlyPaths.length) throw new Error('Bubblewrap sandbox requires runtime read-only paths');
    this.network = options.network ?? false;
    this.memoryMb = positiveInteger(options.memoryMb ?? 512, 'memoryMb');
    this.cpuSeconds = positiveInteger(options.cpuSeconds ?? 30, 'cpuSeconds');
    this.maxProcesses = positiveInteger(options.maxProcesses ?? 64, 'maxProcesses');
  }

  plan(command: string, args: string[], cwd = '.', environment: Record<string, string> = {}): SandboxExecutionPlan {
    const executable = this.validateCommand(command);
    const hostCwd = this.resolveCwd(cwd);
    if (!this.runtimeReadOnlyPaths.some((root) => isInside(executable, root))) {
      throw new Error(`Allowed executable is not available inside configured runtime mounts: ${executable}`);
    }
    const relativeCwd = relative(this.workspace, hostCwd);
    const sandboxCwd = relativeCwd ? `/workspace/${relativeCwd.replaceAll('\\', '/')}` : '/workspace';
    const filtered = this.filterEnvironment(environment);

    const bwrapArgs: string[] = [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      ...(this.network ? [] : ['--unshare-net']),
    ];
    for (const runtimePath of this.runtimeReadOnlyPaths) bwrapArgs.push('--ro-bind', runtimePath, runtimePath);
    bwrapArgs.push(
      '--bind', this.workspace, '/workspace',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--dir', '/home',
      '--clearenv',
      '--setenv', 'PATH', SAFE_PATH,
    );
    for (const [key, value] of Object.entries(filtered)) bwrapArgs.push('--setenv', key, value);
    bwrapArgs.push('--chdir', sandboxCwd, '--', executable, ...args);

    if (this.prlimitExecutable) {
      return {
        backend: this.backend,
        isolated: true,
        executable: this.prlimitExecutable,
        args: [
          `--as=${this.memoryMb * 1024 * 1024}`,
          `--nproc=${this.maxProcesses}`,
          `--cpu=${this.cpuSeconds}`,
          '--',
          this.bwrapExecutable,
          ...bwrapArgs,
        ],
        cwd: this.workspace,
        environment: { PATH: process.env.PATH ?? SAFE_PATH },
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      };
    }

    return {
      backend: this.backend,
      isolated: true,
      executable: this.bwrapExecutable,
      args: bwrapArgs,
      cwd: this.workspace,
      environment: { PATH: process.env.PATH ?? SAFE_PATH },
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    };
  }

  async execute(command: string, args: string[], cwd = '.', environment: Record<string, string> = {}): Promise<SandboxExecutionResult> {
    const plan = this.plan(command, args, cwd, environment);
    const result = await runBounded(plan);
    return { backend: this.backend, isolated: true, command, args: [...args], ...result };
  }
}

export interface SandboxManagerOptions extends StrictSandboxOptions {
  bwrapExecutable?: string;
  prlimitExecutable?: string;
  runtimeReadOnlyPaths?: string[];
  network?: boolean;
  memoryMb?: number;
  cpuSeconds?: number;
  maxProcesses?: number;
  allowUnsafeFallback?: boolean;
  backendAvailability?: { bubblewrap: boolean; prlimit: boolean };
}

export class SandboxManager {
  private readonly options: SandboxManagerOptions;

  constructor(options: SandboxManagerOptions) {
    this.options = options;
  }

  async create(): Promise<ExecutableSandbox> {
    const bwrapExecutable = this.options.bwrapExecutable ?? '/usr/bin/bwrap';
    const prlimitExecutable = this.options.prlimitExecutable ?? '/usr/bin/prlimit';
    const availability = this.options.backendAvailability ?? {
      bubblewrap: process.platform === 'linux' && await executableExists(bwrapExecutable),
      prlimit: process.platform === 'linux' && await executableExists(prlimitExecutable),
    };

    if (process.platform === 'linux' && availability.bubblewrap) {
      return new BubblewrapSandbox({
        workspace: this.options.workspace,
        allowedCommands: this.options.allowedCommands,
        ...(this.options.allowedEnvironmentKeys ? { allowedEnvironmentKeys: this.options.allowedEnvironmentKeys } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.maxOutputBytes !== undefined ? { maxOutputBytes: this.options.maxOutputBytes } : {}),
        bwrapExecutable,
        ...(availability.prlimit ? { prlimitExecutable } : {}),
        ...(this.options.runtimeReadOnlyPaths ? { runtimeReadOnlyPaths: this.options.runtimeReadOnlyPaths } : {}),
        ...(this.options.network !== undefined ? { network: this.options.network } : {}),
        ...(this.options.memoryMb !== undefined ? { memoryMb: this.options.memoryMb } : {}),
        ...(this.options.cpuSeconds !== undefined ? { cpuSeconds: this.options.cpuSeconds } : {}),
        ...(this.options.maxProcesses !== undefined ? { maxProcesses: this.options.maxProcesses } : {}),
      });
    }

    if (this.options.allowUnsafeFallback) {
      return new UnsafeProcessSandbox({
        workspace: this.options.workspace,
        allowedCommands: this.options.allowedCommands,
        ...(this.options.allowedEnvironmentKeys ? { allowedEnvironmentKeys: this.options.allowedEnvironmentKeys } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.maxOutputBytes !== undefined ? { maxOutputBytes: this.options.maxOutputBytes } : {}),
      });
    }
    throw new Error('Isolated sandbox backend unavailable; install Bubblewrap on Linux or explicitly allow the unsafe process fallback.');
  }
}

interface BoundedRunInput {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface BoundedRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function runBounded(input: BoundedRunInput): Promise<BoundedRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = new BoundedBuffer(input.maxOutputBytes);
    const stderr = new BoundedBuffer(input.maxOutputBytes);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? -1,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf8');
  }
}

async function executableExists(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function absoluteExecutable(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isInside(candidate: string, root: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder));
}
