import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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

export interface SandboxReadOnlyBind {
  source: string;
  target: string;
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

export interface SandboxExecutionRequest {
  command: string;
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
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
  cancelled?: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface SandboxSessionRequest {
  command: string;
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
  signal?: AbortSignal;
  /** Optional total session lifetime. Omit for a persistent session. */
  timeoutMs?: number;
  maxFrameBytes?: number;
  closeGraceMs?: number;
}

export interface SandboxSessionExit {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stderrTruncated: boolean;
  error?: string;
}

export interface SandboxSession {
  readonly backend: SandboxBackend;
  readonly isolated: boolean;
  writeLine(line: string): Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (result: SandboxSessionExit) => void): () => void;
  close(): Promise<void>;
  kill(): void;
}

export interface ExecutableSandbox {
  readonly backend: SandboxBackend;
  readonly isolated: boolean;
  execute(command: string, args: string[], cwd?: string, environment?: Record<string, string>): Promise<SandboxExecutionResult>;
  executeRequest(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  spawnSession?: (request: SandboxSessionRequest) => Promise<SandboxSession>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PROTECTED_BIND_TARGETS = ['/workspace', '/home', '/proc', '/dev', '/tmp', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/run'];

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

  execute(command: string, args: string[], cwd = '.', environment: Record<string, string> = {}): Promise<SandboxExecutionResult> {
    return this.executeRequest({ command, args, cwd, environment });
  }

  abstract executeRequest(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  abstract spawnSession(request: SandboxSessionRequest): Promise<SandboxSession>;

  protected validateCommand(command: string): string {
    return assertAbsoluteExecutable(command, this.allowedCommands);
  }

  protected resolveCwd(cwd: string): string {
    return validatePath(resolve(this.workspace, cwd), [this.workspace]);
  }

  protected filterEnvironment(environment: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(environment).filter(([key]) => this.allowedEnvironmentKeys.has(key)));
  }

  protected effectiveTimeout(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) return this.timeoutMs;
    const requested = positiveInteger(timeoutMs, 'timeoutMs');
    return Math.min(this.timeoutMs, requested);
  }
}

export class UnsafeProcessSandbox extends BaseSandbox {
  readonly backend = 'process' as const;
  readonly isolated = false;

  async executeRequest(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (request.signal?.aborted) throw new Error('Sandbox execution cancelled before start');
    const executable = this.validateCommand(request.command);
    const hostCwd = this.resolveCwd(request.cwd ?? '.');
    const filtered = this.filterEnvironment(request.environment ?? {});
    const result = await runBounded({
      executable,
      args: [...request.args],
      cwd: hostCwd,
      environment: { PATH: process.env.PATH ?? SAFE_PATH, ...filtered },
      timeoutMs: this.effectiveTimeout(request.timeoutMs),
      maxOutputBytes: this.maxOutputBytes,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { backend: this.backend, isolated: this.isolated, command: executable, args: [...request.args], ...result };
  }

  async spawnSession(request: SandboxSessionRequest): Promise<SandboxSession> {
    if (request.signal?.aborted) throw new Error('Sandbox session cancelled before start');
    const executable = this.validateCommand(request.command);
    const hostCwd = this.resolveCwd(request.cwd ?? '.');
    const filtered = this.filterEnvironment(request.environment ?? {});
    return spawnPersistentSession({
      backend: this.backend,
      isolated: false,
      executable,
      args: [...request.args],
      cwd: hostCwd,
      environment: { PATH: process.env.PATH ?? SAFE_PATH, ...filtered },
      maxOutputBytes: this.maxOutputBytes,
      maxFrameBytes: positiveInteger(request.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes'),
      closeGraceMs: positiveInteger(request.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS, 'closeGraceMs'),
      ...(request.timeoutMs !== undefined ? { timeoutMs: positiveInteger(request.timeoutMs, 'timeoutMs') } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }
}

export interface BubblewrapSandboxOptions extends StrictSandboxOptions {
  bwrapExecutable: string;
  prlimitExecutable?: string;
  runtimeReadOnlyPaths?: string[];
  readOnlyBinds?: SandboxReadOnlyBind[];
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
  private readonly readOnlyBinds: SandboxReadOnlyBind[];
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
    this.readOnlyBinds = normalizeReadOnlyBinds(options.readOnlyBinds ?? []);
    this.network = options.network ?? false;
    this.memoryMb = positiveInteger(options.memoryMb ?? 512, 'memoryMb');
    this.cpuSeconds = positiveInteger(options.cpuSeconds ?? 30, 'cpuSeconds');
    this.maxProcesses = positiveInteger(options.maxProcesses ?? 64, 'maxProcesses');
  }

  plan(command: string, args: string[], cwd = '.', environment: Record<string, string> = {}, timeoutMs?: number): SandboxExecutionPlan {
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
    for (const directory of readOnlyBindDirectories(this.readOnlyBinds)) bwrapArgs.push('--dir', directory);
    for (const bind of this.readOnlyBinds) bwrapArgs.push('--ro-bind', bind.source, bind.target);
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
        timeoutMs: this.effectiveTimeout(timeoutMs),
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
      timeoutMs: this.effectiveTimeout(timeoutMs),
      maxOutputBytes: this.maxOutputBytes,
    };
  }

  async executeRequest(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (request.signal?.aborted) throw new Error('Sandbox execution cancelled before start');
    const plan = this.plan(request.command, request.args, request.cwd ?? '.', request.environment ?? {}, request.timeoutMs);
    const result = await runBounded({
      ...plan,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { backend: this.backend, isolated: true, command: request.command, args: [...request.args], ...result };
  }

  async spawnSession(request: SandboxSessionRequest): Promise<SandboxSession> {
    if (request.signal?.aborted) throw new Error('Sandbox session cancelled before start');
    const plan = this.plan(request.command, request.args, request.cwd ?? '.', request.environment ?? {}, request.timeoutMs);
    return spawnPersistentSession({
      backend: this.backend,
      isolated: true,
      executable: plan.executable,
      args: [...plan.args],
      cwd: plan.cwd,
      environment: { ...plan.environment },
      maxOutputBytes: plan.maxOutputBytes,
      maxFrameBytes: positiveInteger(request.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes'),
      closeGraceMs: positiveInteger(request.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS, 'closeGraceMs'),
      ...(request.timeoutMs !== undefined ? { timeoutMs: positiveInteger(request.timeoutMs, 'timeoutMs') } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }
}

export interface SandboxManagerOptions extends StrictSandboxOptions {
  bwrapExecutable?: string;
  prlimitExecutable?: string;
  runtimeReadOnlyPaths?: string[];
  readOnlyBinds?: SandboxReadOnlyBind[];
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
        ...(this.options.readOnlyBinds ? { readOnlyBinds: this.options.readOnlyBinds } : {}),
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
  stdin?: string;
  signal?: AbortSignal;
}

interface BoundedRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function runBounded(input: BoundedRunInput): Promise<BoundedRunResult> {
  if (input.signal?.aborted) return Promise.reject(new Error('Sandbox execution cancelled before start'));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = new BoundedBuffer(input.maxOutputBytes);
    const stderr = new BoundedBuffer(input.maxOutputBytes);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        exitCode: exitCode ?? -1,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        cancelled,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

interface PersistentSessionInput {
  backend: SandboxBackend;
  isolated: boolean;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  maxOutputBytes: number;
  maxFrameBytes: number;
  closeGraceMs: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function spawnPersistentSession(input: PersistentSessionInput): SandboxSession {
  if (input.signal?.aborted) throw new Error('Sandbox session cancelled before start');
  const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  return new ProcessSandboxSession(child, input);
}

class ProcessSandboxSession implements SandboxSession {
  readonly backend: SandboxBackend;
  readonly isolated: boolean;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxFrameBytes: number;
  private readonly closeGraceMs: number;
  private readonly stderr: BoundedBuffer;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(result: SandboxSessionExit) => void>();
  private pendingStdout = Buffer.alloc(0);
  private exitResult: SandboxSessionExit | undefined;
  private terminalError: string | undefined;
  private lifetimeTimer: NodeJS.Timeout | undefined;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly abortListener: (() => void) | undefined;

  constructor(child: ChildProcessWithoutNullStreams, input: PersistentSessionInput) {
    this.child = child;
    this.backend = input.backend;
    this.isolated = input.isolated;
    this.maxFrameBytes = input.maxFrameBytes;
    this.closeGraceMs = input.closeGraceMs;
    this.stderr = new BoundedBuffer(input.maxOutputBytes);
    this.abortSignal = input.signal;
    this.abortListener = input.signal ? () => this.fail('Sandbox session cancelled') : undefined;

    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    child.on('error', (error) => this.fail(`Sandbox session process error: ${error.message}`));
    child.on('close', (exitCode, signal) => this.finish(exitCode ?? -1, signal));

    if (input.timeoutMs !== undefined) {
      this.lifetimeTimer = setTimeout(() => this.fail(`Sandbox session timed out after ${input.timeoutMs}ms`), input.timeoutMs);
    }
    input.signal?.addEventListener('abort', this.abortListener!, { once: true });
  }

  async writeLine(line: string): Promise<void> {
    if (this.exitResult) throw new Error('Sandbox session is closed');
    if (line.includes('\n') || line.includes('\r')) throw new Error('Sandbox session line must not contain newline characters');
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > this.maxFrameBytes) throw new Error(`Sandbox session frame exceeds ${this.maxFrameBytes} bytes`);
    const payload = `${line}\n`;
    await new Promise<void>((resolvePromise, reject) => {
      this.child.stdin.write(payload, 'utf8', (error) => error ? reject(error) : resolvePromise());
    });
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (result: SandboxSessionExit) => void): () => void {
    if (this.exitResult) {
      const result = structuredClone(this.exitResult);
      queueMicrotask(() => listener(result));
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.exitResult) return;
    const exited = new Promise<void>((resolvePromise) => {
      const unsubscribe = this.onExit(() => {
        unsubscribe();
        resolvePromise();
      });
    });
    this.child.stdin.end();
    const killer = setTimeout(() => this.kill(), this.closeGraceMs);
    try {
      await exited;
    } finally {
      clearTimeout(killer);
    }
  }

  kill(): void {
    if (this.exitResult || this.child.exitCode !== null || this.child.killed) return;
    this.child.kill('SIGKILL');
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.exitResult || this.terminalError) return;
    this.pendingStdout = this.pendingStdout.length ? Buffer.concat([this.pendingStdout, chunk]) : Buffer.from(chunk);
    for (;;) {
      const newline = this.pendingStdout.indexOf(0x0a);
      if (newline < 0) break;
      const frame = this.pendingStdout.subarray(0, newline);
      this.pendingStdout = this.pendingStdout.subarray(newline + 1);
      const normalized = frame.length && frame[frame.length - 1] === 0x0d ? frame.subarray(0, -1) : frame;
      if (normalized.length > this.maxFrameBytes) {
        this.fail(`Sandbox session stdout frame exceeds ${this.maxFrameBytes} bytes`);
        return;
      }
      const line = normalized.toString('utf8');
      for (const listener of [...this.lineListeners]) listener(line);
    }
    if (this.pendingStdout.length > this.maxFrameBytes) this.fail(`Sandbox session stdout frame exceeds ${this.maxFrameBytes} bytes`);
  }

  private fail(message: string): void {
    if (this.exitResult || this.terminalError) return;
    this.terminalError = message;
    this.kill();
  }

  private finish(exitCode: number, signal: NodeJS.Signals | null): void {
    if (this.exitResult) return;
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    if (this.abortSignal && this.abortListener) this.abortSignal.removeEventListener('abort', this.abortListener);
    const result: SandboxSessionExit = {
      exitCode,
      signal,
      stderr: this.stderr.text(),
      stderrTruncated: this.stderr.truncated,
      ...(this.terminalError ? { error: this.terminalError } : {}),
    };
    this.exitResult = result;
    for (const listener of [...this.exitListeners]) listener(structuredClone(result));
    this.exitListeners.clear();
    this.lineListeners.clear();
  }
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

function normalizeReadOnlyBinds(input: SandboxReadOnlyBind[]): SandboxReadOnlyBind[] {
  const targets = new Set<string>();
  return input.map((bind) => {
    if (!isAbsolute(bind.source)) throw new Error(`Sandbox read-only bind source must be absolute: ${bind.source}`);
    if (!isAbsolute(bind.target)) throw new Error(`Sandbox read-only bind target must be absolute: ${bind.target}`);
    const source = resolve(bind.source);
    const target = resolve(bind.target);
    if (source === '/' || source === '/home' || source === '/root') throw new Error(`Sandbox read-only bind source is too broad or private: ${source}`);
    if (target === '/' || PROTECTED_BIND_TARGETS.some((root) => isPathWithin(target, root))) {
      throw new Error(`Sandbox read-only bind target overlaps a protected path: ${target}`);
    }
    if (targets.has(target)) throw new Error(`Duplicate sandbox read-only bind target: ${target}`);
    targets.add(target);
    return { source, target };
  });
}

function readOnlyBindDirectories(binds: SandboxReadOnlyBind[]): string[] {
  const directories = new Set<string>();
  for (const bind of binds) {
    let current = dirname(bind.target);
    while (current !== '/' && !PROTECTED_BIND_TARGETS.some((root) => isPathWithin(current, root))) {
      directories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...directories].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}
