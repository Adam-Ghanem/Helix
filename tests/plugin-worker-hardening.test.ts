import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PluginArtifactStore,
  PluginWorkerManager,
  type ManagedPluginManifest,
  type PluginWorkerSandboxFactory,
} from '../packages/plugins/src/index.js';
import type {
  ExecutableSandbox,
  SandboxExecutionResult,
  SandboxSession,
  SandboxSessionExit,
} from '../packages/sandbox/src/index.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/plugin-worker.mjs');

test('plugin worker manager requires an absolute Node executable at the security boundary', () => {
  const artifacts = new PluginArtifactStore({ directory: resolve('.tmp-plugin-worker-hardening') });
  const sandboxFactory: PluginWorkerSandboxFactory = {
    create: async () => { throw new Error('not used'); },
  };
  assert.throws(
    () => new PluginWorkerManager({ artifacts, sandboxFactory, nodeExecutable: 'node' }),
    /absolute.*node|node.*absolute/i,
  );
});

test('plugin worker terminates the session on a malformed JSON-RPC error envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helix-plugin-worker-hardening-'));
  try {
    const setup = await workerFixture(root, 'hardening-worker');
    let killed = 0;
    const sandboxFactory: PluginWorkerSandboxFactory = {
      create: async () => {
        const session = new ProtocolSession((line, current) => {
          const request = JSON.parse(line) as { id: string; method: string };
          if (request.method === 'plugin/handshake') {
            current.emitLine(handshakeResponse(request.id, setup.manifest.id));
            return;
          }
          current.emitLine(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: 'not-an-error-object' }));
        }, () => { killed += 1; });
        return isolatedSandbox(session);
      },
    };

    const manager = new PluginWorkerManager({
      artifacts: setup.artifacts,
      sandboxFactory,
      nodeExecutable: process.execPath,
      handshakeTimeoutMs: 500,
    });
    await manager.start(setup.manifest.id, setup.manifest, setup.artifact);
    await assert.rejects(
      () => manager.callTool(setup.manifest.id, 'echo', {}),
      /protocol.*error|error.*object/i,
    );
    assert.equal(killed, 1, 'malformed protocol output must terminate the worker session');
    await manager.stop(setup.manifest.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin worker stop force-kills the isolated session when graceful close fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helix-plugin-worker-stop-'));
  try {
    const setup = await workerFixture(root, 'stop-worker');
    let killed = 0;
    const sandboxFactory: PluginWorkerSandboxFactory = {
      create: async () => isolatedSandbox(new ProtocolSession((line, current) => {
        const request = JSON.parse(line) as { id: string; method: string };
        if (request.method === 'plugin/handshake') current.emitLine(handshakeResponse(request.id, setup.manifest.id));
      }, () => { killed += 1; }, true)),
    };
    const manager = new PluginWorkerManager({
      artifacts: setup.artifacts,
      sandboxFactory,
      nodeExecutable: process.execPath,
      handshakeTimeoutMs: 500,
    });

    await manager.start(setup.manifest.id, setup.manifest, setup.artifact);
    await manager.stop(setup.manifest.id);
    assert.equal(killed, 1, 'failed graceful shutdown must force-kill the isolated worker');
    await assert.rejects(() => manager.callTool(setup.manifest.id, 'echo', {}), /not started/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function workerFixture(root: string, id: string) {
  const bytes = await readFile(FIXTURE);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const artifacts = new PluginArtifactStore({ directory: join(root, 'artifacts') });
  const artifact = await artifacts.install(FIXTURE, digest);
  const manifest: ManagedPluginManifest = {
    id,
    name: 'Hardening Worker',
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['tool:register'],
    capabilities: ['analysis'],
    entrypoint: './worker.mjs',
    artifactDigest: digest,
    signerKeyId: 'test-key',
    signature: 'test-signature',
    contributions: {
      tools: [{ name: 'echo', description: 'Echo', risk: 'low', permissions: [], inputSchema: {} }],
    },
  };
  return { artifacts, artifact, manifest };
}

function handshakeResponse(id: string, pluginId: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { protocolVersion: '1', pluginId, capabilities: { tools: true, hooks: false } },
  });
}

function isolatedSandbox(session: SandboxSession): ExecutableSandbox {
  return {
    backend: 'bubblewrap',
    isolated: true,
    execute: async () => unusedExecutionResult(),
    executeRequest: async () => unusedExecutionResult(),
    spawnSession: async () => session,
  };
}

class ProtocolSession implements SandboxSession {
  readonly backend = 'bubblewrap' as const;
  readonly isolated = true;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(result: SandboxSessionExit) => void>();
  private exited = false;

  constructor(
    private readonly responder: (line: string, session: ProtocolSession) => void,
    private readonly onKill: () => void,
    private readonly closeShouldThrow = false,
  ) {}

  async writeLine(line: string): Promise<void> {
    if (this.exited) throw new Error('session closed');
    queueMicrotask(() => this.responder(line, this));
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (result: SandboxSessionExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closeShouldThrow) throw new Error('graceful close failed');
    this.emitExit({ exitCode: 0, signal: null, stderr: '', stderrTruncated: false });
  }

  kill(): void {
    if (this.exited) return;
    this.onKill();
    this.emitExit({ exitCode: -1, signal: 'SIGKILL', stderr: '', stderrTruncated: false, error: 'killed' });
  }

  emitLine(line: string): void {
    if (this.exited) return;
    for (const listener of [...this.lineListeners]) listener(line);
  }

  private emitExit(result: SandboxSessionExit): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener(result);
  }
}

function unusedExecutionResult(): SandboxExecutionResult {
  return {
    backend: 'bubblewrap', isolated: true, command: process.execPath, args: [], exitCode: 0,
    stdout: '', stderr: '', timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false,
  };
}
