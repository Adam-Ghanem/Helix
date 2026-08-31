import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PluginArtifactStore,
  PluginWorkerManager,
  type ManagedPluginArtifactRecord,
  type ManagedPluginManifest,
  type PluginWorkerSandboxFactory,
} from '../packages/plugins/src/index.js';
import {
  UnsafeProcessSandbox,
  type ExecutableSandbox,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxSession,
  type SandboxSessionExit,
  type SandboxSessionRequest,
} from '../packages/sandbox/src/index.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/plugin-worker.mjs');

async function artifactFixture(id = 'worker') {
  const root = await mkdtemp(join(tmpdir(), 'helix-plugin-worker-'));
  const bytes = await readFile(FIXTURE);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const artifacts = new PluginArtifactStore({ directory: join(root, 'artifacts') });
  const artifact = await artifacts.install(FIXTURE, digest);
  return { root, artifacts, artifact, manifest: workerManifest(id, digest) };
}

function workerManifest(id: string, digest: string): ManagedPluginManifest {
  return {
    id,
    name: `Worker ${id}`,
    version: '1.0.0',
    apiVersion: 'v1',
    permissions: ['tool:register', 'hook:register'],
    capabilities: ['analysis'],
    entrypoint: './worker.mjs',
    artifactDigest: digest,
    signerKeyId: 'test-key',
    signature: 'test-signature',
    contributions: {
      tools: [
        { name: 'echo', description: 'Echo input', risk: 'low', permissions: [], inputSchema: { properties: { text: 'string' } } },
        { name: 'crash', description: 'Crash worker', risk: 'low', permissions: [], inputSchema: {} },
      ],
      hooks: [{ name: 'audit', events: ['pre-tool'], priority: 1, critical: true, timeoutMs: 200 }],
    },
  };
}

test('plugin worker starts only through an isolated session and proxies tool/hook JSONL RPC', async () => {
  const fixture = await artifactFixture('rpc-worker');
  try {
    const launches: Array<{ network: boolean; artifactPath: string }> = [];
    const requests: SandboxSessionRequest[] = [];
    const factory = recordingProcessFactory(fixture.root, launches, requests);
    const manager = new PluginWorkerManager({
      artifacts: fixture.artifacts,
      sandboxFactory: factory,
      nodeExecutable: process.execPath,
      handshakeTimeoutMs: 1_000,
    });

    await manager.start(fixture.manifest.id, fixture.manifest, fixture.artifact);
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0], { network: false, artifactPath: fixture.artifact.path });
    assert.deepEqual(requests[0]?.args, ['/plugin/worker.mjs']);
    assert.notEqual(requests[0]?.args[0], fixture.artifact.path);

    const tool = await manager.callTool(fixture.manifest.id, 'echo', { text: 'hello' });
    assert.deepEqual(tool, { name: 'echo', input: { text: 'hello' } });

    const hook = await manager.callHook(fixture.manifest.id, 'audit', 'pre-tool', { executionId: 'ex_1' }, 500);
    assert.deepEqual(hook, { name: 'audit', event: 'pre-tool', context: { executionId: 'ex_1' } });

    await manager.stop(fixture.manifest.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('plugin worker refuses a sandbox that is not actually isolated', async () => {
  const fixture = await artifactFixture('unsafe-worker');
  try {
    const unsafe = new UnsafeProcessSandbox({ workspace: fixture.root, allowedCommands: [process.execPath] });
    const factory: PluginWorkerSandboxFactory = {
      create: async () => unsafe,
    };
    const manager = new PluginWorkerManager({ artifacts: fixture.artifacts, sandboxFactory: factory, nodeExecutable: process.execPath });
    await assert.rejects(() => manager.start(fixture.manifest.id, fixture.manifest, fixture.artifact), /isolat|unsafe|sandbox/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('plugin worker fails closed on malformed, mismatched, oversized, and timed-out handshake responses', async () => {
  const cases: Array<{ name: string; maxFrameBytes?: number; timeoutMs?: number; responder: (line: string, session: ScriptedSession) => void; pattern: RegExp }> = [
    {
      name: 'malformed',
      responder: (_line, session) => session.emitLine('{not-json'),
      pattern: /json|protocol|malformed/i,
    },
    {
      name: 'mismatched-id',
      responder: (line, session) => {
        const request = JSON.parse(line) as { id: string };
        session.emitLine(JSON.stringify({ jsonrpc: '2.0', id: `${request.id}-wrong`, result: { protocolVersion: '1', pluginId: 'protocol-worker', capabilities: { tools: true, hooks: true } } }));
      },
      pattern: /id|protocol|response/i,
    },
    {
      name: 'oversized',
      maxFrameBytes: 64,
      responder: (_line, session) => session.emitLine('x'.repeat(65)),
      pattern: /frame|64|large|protocol/i,
    },
    {
      name: 'timeout',
      timeoutMs: 20,
      responder: () => undefined,
      pattern: /timeout|timed out|handshake/i,
    },
  ];

  for (const scenario of cases) {
    const fixture = await artifactFixture('protocol-worker');
    try {
      const factory = scriptedFactory(scenario.responder);
      const manager = new PluginWorkerManager({
        artifacts: fixture.artifacts,
        sandboxFactory: factory,
        nodeExecutable: process.execPath,
        handshakeTimeoutMs: scenario.timeoutMs ?? 200,
        ...(scenario.maxFrameBytes ? { maxFrameBytes: scenario.maxFrameBytes } : {}),
      });
      await assert.rejects(() => manager.start(fixture.manifest.id, fixture.manifest, fixture.artifact), scenario.pattern, scenario.name);
      await manager.stop(fixture.manifest.id).catch(() => undefined);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('plugin worker permits three crash restarts then opens the circuit instead of respawning forever', async () => {
  const fixture = await artifactFixture('crash-worker');
  try {
    const launches: Array<{ network: boolean; artifactPath: string }> = [];
    const requests: SandboxSessionRequest[] = [];
    const manager = new PluginWorkerManager({
      artifacts: fixture.artifacts,
      sandboxFactory: recordingProcessFactory(fixture.root, launches, requests),
      nodeExecutable: process.execPath,
      maxRestarts: 3,
      handshakeTimeoutMs: 1_000,
    });
    await manager.start(fixture.manifest.id, fixture.manifest, fixture.artifact);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(() => manager.callTool(fixture.manifest.id, 'crash', {}, 1_000), /worker|exit|closed|crash|session/i);
    }
    assert.equal(launches.length, 4, 'initial launch plus exactly three restarts');
    await assert.rejects(() => manager.callTool(fixture.manifest.id, 'echo', { text: 'never' }), /circuit|restart|unhealthy/i);
    assert.equal(launches.length, 4, 'open circuit must block another process launch');
    await manager.stop(fixture.manifest.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function recordingProcessFactory(
  workspace: string,
  launches: Array<{ network: boolean; artifactPath: string }>,
  requests: SandboxSessionRequest[],
): PluginWorkerSandboxFactory {
  return {
    create: async (input) => {
      launches.push({ network: input.network, artifactPath: input.artifact.path });
      const host = new UnsafeProcessSandbox({
        workspace,
        allowedCommands: [input.nodeExecutable],
        allowedEnvironmentKeys: ['HELIX_PLUGIN_ID', 'HELIX_PLUGIN_PROTOCOL_VERSION'],
      });
      return {
        backend: 'bubblewrap',
        isolated: true,
        execute: async (...args) => host.execute(...args),
        executeRequest: async (request: SandboxExecutionRequest): Promise<SandboxExecutionResult> => host.executeRequest(request),
        spawnSession: async (request: SandboxSessionRequest): Promise<SandboxSession> => {
          requests.push(structuredClone(request));
          const hostSession = await host.spawnSession({ ...request, args: request.args.map((arg) => arg === '/plugin/worker.mjs' ? FIXTURE : arg) });
          return isolatedSession(hostSession);
        },
      } satisfies ExecutableSandbox;
    },
  };
}

function isolatedSession(session: SandboxSession): SandboxSession {
  return {
    backend: 'bubblewrap',
    isolated: true,
    writeLine: (line) => session.writeLine(line),
    onLine: (listener) => session.onLine(listener),
    onExit: (listener) => session.onExit(listener),
    close: () => session.close(),
    kill: () => session.kill(),
  };
}

function scriptedFactory(responder: (line: string, session: ScriptedSession) => void): PluginWorkerSandboxFactory {
  return {
    create: async () => {
      const session = new ScriptedSession(responder);
      return {
        backend: 'bubblewrap',
        isolated: true,
        execute: async () => unusedExecutionResult(),
        executeRequest: async () => unusedExecutionResult(),
        spawnSession: async () => session,
      } satisfies ExecutableSandbox;
    },
  };
}

class ScriptedSession implements SandboxSession {
  readonly backend = 'bubblewrap' as const;
  readonly isolated = true;
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(result: SandboxSessionExit) => void>();
  private exited = false;

  constructor(private readonly responder: (line: string, session: ScriptedSession) => void) {}

  async writeLine(line: string): Promise<void> {
    if (this.exited) throw new Error('scripted session closed');
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
    this.emitExit({ exitCode: 0, signal: null, stderr: '', stderrTruncated: false });
  }

  kill(): void {
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
