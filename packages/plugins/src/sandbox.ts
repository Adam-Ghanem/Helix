import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SandboxManager, type ExecutableSandbox, type SandboxManagerOptions } from '../../sandbox/src/index.js';
import type { PluginWorkerSandboxFactory, PluginWorkerSandboxFactoryInput } from './worker.js';

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export interface StrictPluginWorkerSandboxFactoryOptions {
  workspaceRoot: string;
  bwrapExecutable?: string;
  prlimitExecutable?: string;
  runtimeReadOnlyPaths?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  memoryMb?: number;
  cpuSeconds?: number;
  maxProcesses?: number;
  backendAvailability?: { bubblewrap: boolean; prlimit: boolean };
}

/**
 * Production plugin sandbox factory. It never opts into the unsafe process
 * fallback and the verified artifact is exposed only as /plugin/worker.mjs.
 */
export class StrictPluginWorkerSandboxFactory implements PluginWorkerSandboxFactory {
  private readonly workspaceRoot: string;
  private readonly options: Omit<StrictPluginWorkerSandboxFactoryOptions, 'workspaceRoot'>;

  constructor(options: StrictPluginWorkerSandboxFactoryOptions) {
    if (!isAbsolute(options.workspaceRoot)) throw new Error('Plugin worker workspaceRoot must be absolute');
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.options = { ...options };
  }

  async create(input: PluginWorkerSandboxFactoryInput): Promise<ExecutableSandbox> {
    if (!PLUGIN_ID_PATTERN.test(input.pluginId)) throw new Error(`Invalid plugin worker id: ${input.pluginId}`);
    if (!isAbsolute(input.nodeExecutable)) throw new Error('Plugin worker Node executable must be absolute');
    if (!isAbsolute(input.artifact.path)) throw new Error('Plugin worker artifact path must be absolute');

    const workspace = resolve(this.workspaceRoot, input.pluginId);
    if (!isInside(workspace, this.workspaceRoot) || workspace === this.workspaceRoot) {
      throw new Error(`Plugin worker workspace escapes root: ${input.pluginId}`);
    }
    await mkdir(workspace, { recursive: true, mode: 0o700 });

    const runtimeReadOnlyPaths = this.options.runtimeReadOnlyPaths
      ? [...this.options.runtimeReadOnlyPaths]
      : defaultRuntimePaths(input.nodeExecutable);

    const managerOptions: SandboxManagerOptions = {
      workspace,
      allowedCommands: [resolve(input.nodeExecutable)],
      allowedEnvironmentKeys: ['HELIX_PLUGIN_ID', 'HELIX_PLUGIN_PROTOCOL_VERSION'],
      readOnlyBinds: [{ source: resolve(input.artifact.path), target: '/plugin/worker.mjs' }],
      runtimeReadOnlyPaths,
      network: input.network,
      ...(this.options.bwrapExecutable ? { bwrapExecutable: this.options.bwrapExecutable } : {}),
      ...(this.options.prlimitExecutable ? { prlimitExecutable: this.options.prlimitExecutable } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.maxOutputBytes !== undefined ? { maxOutputBytes: this.options.maxOutputBytes } : {}),
      ...(this.options.memoryMb !== undefined ? { memoryMb: this.options.memoryMb } : {}),
      ...(this.options.cpuSeconds !== undefined ? { cpuSeconds: this.options.cpuSeconds } : {}),
      ...(this.options.maxProcesses !== undefined ? { maxProcesses: this.options.maxProcesses } : {}),
      ...(this.options.backendAvailability ? { backendAvailability: this.options.backendAvailability } : {}),
    };
    return new SandboxManager(managerOptions).create();
  }
}

function defaultRuntimePaths(nodeExecutable: string): string[] {
  const candidates = ['/usr', '/bin', '/lib', '/lib64', dirname(resolve(nodeExecutable))];
  const unique: string[] = [];
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (unique.some((root) => isInside(normalized, root))) continue;
    unique.push(normalized);
  }
  return unique;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
