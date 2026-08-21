export type SandboxStatus = 'creating' | 'ready' | 'running' | 'stopped' | 'failed' | 'destroyed';
export type NetworkMode = 'none' | 'host' | 'bridge' | 'custom';

export interface SandboxPolicy {
  allowedExecutables: string[];
  allowedPaths: string[];
  deniedPaths: string[];
  environmentAllowlist: string[];
  networkMode: NetworkMode;
  timeoutMs: number;
  memoryLimitMb: number;
  cpuLimit: number;
  maxProcesses: number;
  readOnlyRoot: boolean;
  workspacePath: string;
  containerImage: string;
  user: string;
  allowNetwork: boolean;
  allowChildProcesses: boolean;
}

export interface SandboxCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface SandboxResourceUsage {
  durationMs: number;
  memoryLimitMb: number;
  cpuLimit: number;
  maxProcesses: number;
  networkMode: NetworkMode;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
  sandboxId: string;
  resourceUsage: SandboxResourceUsage;
  auditId: string;
  limitations?: string[];
}

export interface SandboxSnapshot {
  sandboxId: string;
  status: SandboxStatus;
  policy: SandboxPolicy;
  createdAt: string;
  backend: string;
}

export interface SandboxBackend {
  readonly name: string;
  create(): Promise<void>;
  start(): Promise<void>;
  exec(command: SandboxCommand): Promise<SandboxResult>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  status(): SandboxStatus;
  snapshot(): SandboxSnapshot;
}

export function defaultSandboxPolicy(workspacePath: string): SandboxPolicy {
  return {
    allowedExecutables: [],
    allowedPaths: [workspacePath],
    deniedPaths: ['/etc', '/proc', '/sys', '/dev'],
    environmentAllowlist: [],
    networkMode: 'none',
    timeoutMs: 30_000,
    memoryLimitMb: 512,
    cpuLimit: 1,
    maxProcesses: 32,
    readOnlyRoot: true,
    workspacePath,
    containerImage: 'node:20-bookworm-slim',
    user: '1000:1000',
    allowNetwork: false,
    allowChildProcesses: false,
  };
}
