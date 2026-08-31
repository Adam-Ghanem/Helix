import { randomUUID } from 'node:crypto';
import type {
  ExecutableSandbox,
  SandboxSession,
  SandboxSessionExit,
  SandboxSessionRequest,
} from '../../sandbox/src/index.js';
import { PluginArtifactStore } from './artifacts.js';
import type { ManagedPluginManifest } from './manifest.js';
import type { ManagedPluginArtifactRecord } from './store.js';

const PLUGIN_WORKER_PROTOCOL_VERSION = '1';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_RESTARTS = 3;
const MAX_PENDING_REQUESTS = 16;

export interface PluginWorkerSandboxFactoryInput {
  pluginId: string;
  manifest: ManagedPluginManifest;
  artifact: ManagedPluginArtifactRecord;
  nodeExecutable: string;
  network: boolean;
}

export interface PluginWorkerSandboxFactory {
  create(input: PluginWorkerSandboxFactoryInput): Promise<ExecutableSandbox>;
}

export interface PluginWorkerManagerOptions {
  artifacts: PluginArtifactStore;
  sandboxFactory: PluginWorkerSandboxFactory;
  nodeExecutable: string;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maxRestarts?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerState {
  pluginId: string;
  manifest: ManagedPluginManifest;
  artifact: ManagedPluginArtifactRecord;
  session: SandboxSession | undefined;
  pending: Map<string, PendingRequest>;
  restartCount: number;
  stopping: boolean;
  circuitOpen: boolean;
  lastFailure: string | undefined;
  launchPromise: Promise<void> | undefined;
  unsubscribeLine: (() => void) | undefined;
  unsubscribeExit: (() => void) | undefined;
}

export class PluginWorkerManager {
  private readonly artifacts: PluginArtifactStore;
  private readonly sandboxFactory: PluginWorkerSandboxFactory;
  private readonly nodeExecutable: string;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxRestarts: number;
  private readonly workers = new Map<string, WorkerState>();

  constructor(options: PluginWorkerManagerOptions) {
    this.artifacts = options.artifacts;
    this.sandboxFactory = options.sandboxFactory;
    if (!options.nodeExecutable.trim()) throw new Error('Plugin worker nodeExecutable is required');
    this.nodeExecutable = options.nodeExecutable;
    this.handshakeTimeoutMs = positiveInteger(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeTimeoutMs');
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs');
    this.maxFrameBytes = positiveInteger(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes');
    this.maxRestarts = nonNegativeInteger(options.maxRestarts ?? DEFAULT_MAX_RESTARTS, 'maxRestarts');
  }

  async preflight(pluginId: string, manifest: ManagedPluginManifest, artifact: ManagedPluginArtifactRecord): Promise<void> {
    if (this.workers.has(pluginId)) throw new Error(`Plugin worker already started: ${pluginId}`);
    const state = this.newState(pluginId, manifest, artifact);
    try {
      await this.launch(state);
    } finally {
      await this.closeDetachedState(state);
    }
  }

  async start(pluginId: string, manifest: ManagedPluginManifest, artifact: ManagedPluginArtifactRecord): Promise<void> {
    if (this.workers.has(pluginId)) throw new Error(`Plugin worker already started: ${pluginId}`);
    const state = this.newState(pluginId, manifest, artifact);
    this.workers.set(pluginId, state);
    try {
      await this.launch(state);
    } catch (error) {
      await this.cleanupFailedStart(state);
      this.workers.delete(pluginId);
      throw error;
    }
  }

  async callTool(pluginId: string, name: string, input: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const state = this.requireState(pluginId);
    if (!state.manifest.contributions?.tools?.some((tool) => tool.name === name)) {
      throw new Error(`Plugin tool is not declared: ${pluginId}:${name}`);
    }
    await this.ensureSession(state);
    return this.request(state, 'tool/call', { name, input: structuredClone(input) }, timeoutMs);
  }

  async callHook(
    pluginId: string,
    name: string,
    event: string,
    context: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const state = this.requireState(pluginId);
    const hook = state.manifest.contributions?.hooks?.find((candidate) => candidate.name === name);
    if (!hook) throw new Error(`Plugin hook is not declared: ${pluginId}:${name}`);
    if (!hook.events.includes(event as never)) throw new Error(`Plugin hook event is not declared: ${pluginId}:${name}:${event}`);
    await this.ensureSession(state);
    return this.request(state, 'hook/call', { name, event, context: structuredClone(context) }, timeoutMs);
  }

  async stop(pluginId: string): Promise<void> {
    const state = this.workers.get(pluginId);
    if (!state) return;
    state.stopping = true;
    state.circuitOpen = true;
    this.rejectPending(state, new Error(`Plugin worker stopped: ${pluginId}`));
    this.unsubscribe(state);
    const session = state.session;
    state.session = undefined;
    try {
      await session?.close();
    } finally {
      this.workers.delete(pluginId);
    }
  }

  async stopAll(): Promise<void> {
    for (const pluginId of [...this.workers.keys()]) await this.stop(pluginId);
  }

  private newState(pluginId: string, manifest: ManagedPluginManifest, artifact: ManagedPluginArtifactRecord): WorkerState {
    if (!pluginId.trim()) throw new Error('Plugin worker id is required');
    if (manifest.id !== pluginId) throw new Error(`Plugin worker manifest id mismatch: expected ${pluginId}, received ${manifest.id}`);
    return {
      pluginId,
      manifest: structuredClone(manifest),
      artifact: structuredClone(artifact),
      session: undefined,
      pending: new Map(),
      restartCount: 0,
      stopping: false,
      circuitOpen: false,
      lastFailure: undefined,
      launchPromise: undefined,
      unsubscribeLine: undefined,
      unsubscribeExit: undefined,
    };
  }

  private requireState(pluginId: string): WorkerState {
    const state = this.workers.get(pluginId);
    if (!state) throw new Error(`Plugin worker is not started: ${pluginId}`);
    return state;
  }

  private async ensureSession(state: WorkerState): Promise<void> {
    if (state.circuitOpen) throw this.unhealthyError(state);
    if (state.session) return;
    if (state.launchPromise) return state.launchPromise;
    if (state.restartCount >= this.maxRestarts) {
      state.circuitOpen = true;
      throw this.unhealthyError(state);
    }
    state.restartCount += 1;
    const launch = this.launch(state);
    state.launchPromise = launch;
    try {
      await launch;
    } finally {
      if (state.launchPromise === launch) state.launchPromise = undefined;
    }
  }

  private async launch(state: WorkerState): Promise<void> {
    const artifact = await this.artifacts.verify(state.artifact, state.manifest.artifactDigest);
    state.artifact = structuredClone(artifact);

    const sandbox = await this.sandboxFactory.create({
      pluginId: state.pluginId,
      manifest: structuredClone(state.manifest),
      artifact: structuredClone(artifact),
      nodeExecutable: this.nodeExecutable,
      network: state.manifest.permissions.includes('network:egress'),
    });
    if (!sandbox.isolated) throw new Error(`Plugin worker requires an isolated sandbox: ${state.pluginId}`);
    if (!sandbox.spawnSession) throw new Error(`Plugin worker sandbox does not support persistent isolated sessions: ${state.pluginId}`);

    const request: SandboxSessionRequest = {
      command: this.nodeExecutable,
      args: ['/plugin/worker.mjs'],
      cwd: '.',
      environment: {
        HELIX_PLUGIN_ID: state.pluginId,
        HELIX_PLUGIN_PROTOCOL_VERSION: PLUGIN_WORKER_PROTOCOL_VERSION,
      },
      maxFrameBytes: this.maxFrameBytes,
    };
    const session = await sandbox.spawnSession(request);
    if (!session.isolated) {
      session.kill();
      throw new Error(`Plugin worker session is not isolated: ${state.pluginId}`);
    }

    state.session = session;
    state.lastFailure = undefined;
    state.unsubscribeLine = session.onLine((line) => this.handleLine(state, line));
    state.unsubscribeExit = session.onExit((result) => this.handleExit(state, result));

    try {
      const handshake = await this.request(
        state,
        'plugin/handshake',
        { pluginId: state.pluginId, apiVersion: state.manifest.apiVersion },
        this.handshakeTimeoutMs,
      );
      this.validateHandshake(state, handshake);
    } catch (error) {
      const failure = asError(error, `Plugin worker handshake failed: ${state.pluginId}`);
      this.failSession(state, failure);
      throw failure;
    }
  }

  private request(state: WorkerState, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const session = state.session;
    if (!session) return Promise.reject(this.unhealthyError(state));
    if (state.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error(`Plugin worker pending request limit exceeded: ${MAX_PENDING_REQUESTS}`));
    }
    const effectiveTimeout = Math.min(this.requestTimeoutMs, positiveInteger(timeoutMs, 'timeoutMs'));
    const id = randomUUID();
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(frame, 'utf8') > this.maxFrameBytes) {
      return Promise.reject(new Error(`Plugin worker request frame exceeds ${this.maxFrameBytes} bytes: ${method}`));
    }

    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const pending = state.pending.get(id);
        if (!pending) return;
        state.pending.delete(id);
        const error = new Error(`Plugin worker request timed out after ${effectiveTimeout}ms: ${method}`);
        pending.reject(error);
        this.failSession(state, error);
      }, effectiveTimeout);
      state.pending.set(id, { resolve: resolvePromise, reject, timer });

      session.writeLine(frame).catch((error) => {
        const pending = state.pending.get(id);
        if (!pending) return;
        state.pending.delete(id);
        clearTimeout(pending.timer);
        const failure = asError(error, `Plugin worker write failed: ${method}`);
        pending.reject(failure);
        this.failSession(state, failure);
      });
    });
  }

  private handleLine(state: WorkerState, line: string): void {
    if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
      this.failSession(state, new Error(`Plugin worker protocol frame exceeds ${this.maxFrameBytes} bytes`));
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.failSession(state, new Error('Plugin worker protocol received malformed JSON'));
      return;
    }
    if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.id !== 'string' || !value.id) {
      this.failSession(state, new Error('Plugin worker protocol response is invalid'));
      return;
    }

    const pending = state.pending.get(value.id);
    if (!pending) {
      this.failSession(state, new Error(`Plugin worker protocol response id is unknown: ${value.id}`));
      return;
    }
    state.pending.delete(value.id);
    clearTimeout(pending.timer);

    const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
    if (hasResult === hasError) {
      const error = new Error('Plugin worker protocol response must contain exactly one of result or error');
      pending.reject(error);
      this.failSession(state, error);
      return;
    }
    if (hasError) {
      const remote = isRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : 'remote worker error';
      pending.reject(new Error(`Plugin worker error: ${remote}`));
      return;
    }
    pending.resolve(value.result);
  }

  private handleExit(state: WorkerState, result: SandboxSessionExit): void {
    state.session = undefined;
    this.unsubscribe(state);
    if (state.stopping) return;

    const details = result.error ?? (result.stderr.trim() || `exit code ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}`);
    const error = new Error(`Plugin worker exited: ${state.pluginId}: ${details}`);
    state.lastFailure = error.message;
    this.rejectPending(state, error);
    if (state.restartCount >= this.maxRestarts) state.circuitOpen = true;
  }

  private failSession(state: WorkerState, error: Error): void {
    if (state.stopping) return;
    state.lastFailure = error.message;
    this.rejectPending(state, error);
    const session = state.session;
    state.session = undefined;
    this.unsubscribe(state);
    session?.kill();
    if (state.restartCount >= this.maxRestarts) state.circuitOpen = true;
  }

  private unsubscribe(state: WorkerState): void {
    state.unsubscribeLine?.();
    state.unsubscribeExit?.();
    state.unsubscribeLine = undefined;
    state.unsubscribeExit = undefined;
  }

  private rejectPending(state: WorkerState, error: Error): void {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
  }

  private validateHandshake(state: WorkerState, value: unknown): void {
    if (!isRecord(value)) throw new Error('Plugin worker handshake result must be an object');
    if (value.protocolVersion !== PLUGIN_WORKER_PROTOCOL_VERSION) throw new Error(`Plugin worker protocol version mismatch: ${String(value.protocolVersion)}`);
    if (value.pluginId !== state.pluginId) throw new Error(`Plugin worker handshake plugin id mismatch: ${String(value.pluginId)}`);
    if (!isRecord(value.capabilities)) throw new Error('Plugin worker handshake capabilities are invalid');

    if ((state.manifest.contributions?.tools?.length ?? 0) > 0 && value.capabilities.tools !== true) {
      throw new Error('Plugin worker handshake does not advertise tool capability');
    }
    if ((state.manifest.contributions?.hooks?.length ?? 0) > 0 && value.capabilities.hooks !== true) {
      throw new Error('Plugin worker handshake does not advertise hook capability');
    }
  }

  private unhealthyError(state: WorkerState): Error {
    const suffix = state.lastFailure ? `; last failure: ${state.lastFailure}` : '';
    return new Error(`Plugin worker circuit is open or worker is unhealthy: ${state.pluginId}${suffix}`);
  }

  private async closeDetachedState(state: WorkerState): Promise<void> {
    state.stopping = true;
    this.rejectPending(state, new Error(`Plugin worker preflight completed: ${state.pluginId}`));
    this.unsubscribe(state);
    const session = state.session;
    state.session = undefined;
    if (!session) return;
    try {
      await session.close();
    } catch {
      session.kill();
    }
  }

  private async cleanupFailedStart(state: WorkerState): Promise<void> {
    state.stopping = true;
    this.rejectPending(state, new Error(`Plugin worker failed to start: ${state.pluginId}`));
    this.unsubscribe(state);
    const session = state.session;
    state.session = undefined;
    if (session) {
      try {
        await session.close();
      } catch {
        session.kill();
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(value === undefined ? fallback : `${fallback}: ${String(value)}`);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
