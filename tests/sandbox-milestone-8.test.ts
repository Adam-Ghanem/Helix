import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SandboxManager } from '../packages/sandbox/src/manager.js';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { LocalSandbox } from '../packages/sandbox/src/local.js';
import { buildDockerRunArgs, dockerAvailable } from '../packages/sandbox/src/docker.js';
import { defaultSandboxPolicy, SandboxPolicy } from '../packages/sandbox/src/types.js';

function policy(workspace: string): SandboxPolicy {
  return { ...defaultSandboxPolicy(workspace), allowedExecutables: [process.execPath], environmentAllowlist: ['HELIX_ALLOWED'] };
}

async function withWorkspace<T>(work: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'helix-m8-'));
  try { return await work(workspace); } finally { await rm(workspace, { recursive: true, force: true }); }
}

async function runLocal(workspace: string, command: string, args: string[], overrides: Partial<SandboxPolicy> = {}) {
  const sandbox = new LocalSandbox({ ...policy(workspace), ...overrides });
  await sandbox.create();
  await sandbox.start();
  return { sandbox, result: await sandbox.exec({ command, args, cwd: '.', env: {} }) };
}

test('allowed command succeeds inside LocalSandbox', async () => withWorkspace(async (workspace) => {
  const { result } = await runLocal(workspace, process.execPath, ['-e', "process.stdout.write('allowed')"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'allowed');
  assert.equal(result.timedOut, false);
}));

test('unauthorized executable fails before launch', async () => withWorkspace(async (workspace) => {
  const sandbox = new LocalSandbox({ ...policy(workspace), allowedExecutables: [] });
  await sandbox.create(); await sandbox.start();
  await assert.rejects(() => sandbox.exec({ command: process.execPath, args: [], cwd: '.', env: {} }), /not allowlisted/);
}));

test('workspace cwd succeeds and traversal is rejected', async () => withWorkspace(async (workspace) => {
  const { result } = await runLocal(workspace, process.execPath, ['-e', 'process.stdout.write(process.cwd())']);
  assert.equal(result.stdout, workspace);
  const sandbox = new LocalSandbox(policy(workspace));
  await sandbox.create(); await sandbox.start();
  await assert.rejects(() => sandbox.exec({ command: process.execPath, args: ['-e', ''], cwd: '../', env: {} }), /escapes allowed workspace/);
  await assert.rejects(() => sandbox.exec({ command: process.execPath, args: ['-e', ''], cwd: '%2e%2e', env: {} }), /escapes allowed workspace/);
  await assert.rejects(() => sandbox.exec({ command: process.execPath, args: ['-e', ''], cwd: '/etc', env: {} }), /escapes allowed workspace|denied/);
}));

test('denied paths and symlink escapes are rejected', async () => withWorkspace(async (workspace) => {
  await symlink('/etc', join(workspace, 'etc-link'));
  const sandbox = new LocalSandbox(policy(workspace));
  await sandbox.create(); await sandbox.start();
  await assert.rejects(() => sandbox.exec({ command: process.execPath, args: ['-e', ''], cwd: 'etc-link', env: {} }), /denied|escapes/);
  await assert.rejects(() => sandbox.exec({ command: process.execPath, args: ['-e', ''], cwd: '/proc', env: {} }), /denied|escapes/);
}));

test('environment filtering excludes unauthorized variables', async () => withWorkspace(async (workspace) => {
  const sandbox = new LocalSandbox({ ...policy(workspace), environmentAllowlist: [] });
  await sandbox.create(); await sandbox.start();
  const result = await sandbox.exec({ command: process.execPath, args: ['-e', "process.stdout.write(`${process.env.HELIX_ALLOWED ?? ''}|${process.env.HELIX_SECRET ?? ''}`)"], cwd: '.', env: { HELIX_ALLOWED: 'yes', HELIX_SECRET: 'no' } });
  assert.equal(result.stdout, '|');
  const allowed = new LocalSandbox({ ...policy(workspace), environmentAllowlist: ['HELIX_ALLOWED'] });
  await allowed.create(); await allowed.start();
  const allowedResult = await allowed.exec({ command: process.execPath, args: ['-e', "process.stdout.write(`${process.env.HELIX_ALLOWED ?? ''}|${process.env.HELIX_SECRET ?? ''}`)"], cwd: '.', env: { HELIX_ALLOWED: 'yes', HELIX_SECRET: 'no' } });
  assert.equal(allowedResult.stdout, 'yes|');
}));

test('timeout kills a long-running process', async () => withWorkspace(async (workspace) => {
  const { result } = await runLocal(workspace, process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.equal(result.killed, true);
  assert.notEqual(result.exitCode, 0);
}));

test('destroy stops the sandbox and leaves no running process', async () => withWorkspace(async (workspace) => {
  const sandbox = new LocalSandbox(policy(workspace));
  await sandbox.create(); await sandbox.start();
  assert.equal(sandbox.status(), 'running');
  await sandbox.destroy();
  assert.equal(sandbox.status(), 'destroyed');
  assert.equal(sandbox.snapshot().status, 'destroyed');
}));

test('SandboxManager creates lifecycle audit records without persisting secret values', async () => withWorkspace(async (workspace) => {
  const manager = new SandboxManager(); await manager.init();
  const created = await manager.create({ policy: policy(workspace), executionId: 'ex-m8', agentId: 'agent-m8' });
  await manager.start(created.sandboxId);
  const result = await manager.exec(created.sandboxId, { command: process.execPath, args: ['-e', "process.stdout.write(process.env.SECRET ?? 'empty')"], cwd: '.', env: { SECRET: 'do-not-log' } });
  assert.equal(result.stdout, 'empty');
  const records = manager.audits(created.sandboxId);
  assert.equal(records.some((record) => record.operation === 'exec'), true);
  assert.equal(JSON.stringify(records).includes('do-not-log'), false);
  await manager.destroy(created.sandboxId);
  assert.equal(manager.status(created.sandboxId).status, 'destroyed');
}));

test('default policy disables network and requests read-only root and non-root user', () => {
  const defaults = defaultSandboxPolicy('/workspace');
  assert.equal(defaults.allowNetwork, false);
  assert.equal(defaults.networkMode, 'none');
  assert.equal(defaults.readOnlyRoot, true);
  assert.notEqual(defaults.user, 'root');
});

test('Docker policy generation never enables privileged mode or Docker socket mounts', () => {
  const args = buildDockerRunArgs('helix-test', { ...defaultSandboxPolicy('/tmp/workspace'), allowedExecutables: [process.execPath] });
  assert.equal(args.includes('--privileged'), false);
  assert.equal(args.some((arg) => arg.includes('/var/run/docker.sock')), false);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--read-only')], '--read-only');
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '32');
  assert.equal(args.includes('--cap-drop') && args[args.indexOf('--cap-drop') + 1] === 'ALL', true);
});

test('Docker availability is reported without making Docker a unit-test prerequisite', async () => {
  const available = await dockerAvailable();
  assert.equal(typeof available, 'boolean');
});

test('100 sequential local sandbox executions complete and cleanly reuse policy', async () => withWorkspace(async (workspace) => {
  const sandbox = new LocalSandbox(policy(workspace)); await sandbox.create(); await sandbox.start();
  for (let index = 0; index < 100; index += 1) {
    const result = await sandbox.exec({ command: process.execPath, args: ['-e', `process.stdout.write('${index}')`], cwd: '.', env: {} });
    assert.equal(result.stdout, String(index));
  }
  await sandbox.destroy();
}));

test('concurrent local sandbox executions do not collide', async () => withWorkspace(async (workspace) => {
  const sandbox = new LocalSandbox(policy(workspace)); await sandbox.create(); await sandbox.start();
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => sandbox.exec({ command: process.execPath, args: ['-e', `setTimeout(() => process.stdout.write('${index}'), 1)`], cwd: '.', env: {} })));
  assert.deepEqual(results.map((result) => result.stdout).sort(), Array.from({ length: 20 }, (_, index) => String(index)).sort());
  await sandbox.destroy();
}));


test('HelixRuntime optionally executes a command through SandboxManager', async () => withWorkspace(async (workspace) => {
  const runtime = new HelixRuntime({ dataDirectory: workspace });
  const execution = await runtime.execute({
    goal: 'run a bounded sandbox command',
    sandbox: {
      enabled: true,
      backend: 'local',
      policy: { workspacePath: workspace, allowedExecutables: [process.execPath], environmentAllowlist: [] },
      command: { command: process.execPath, args: ['-e', "process.stdout.write('runtime-sandbox-ok')"] },
    },
  });
  assert.equal(execution.status, 'completed');
  assert.equal((execution.result as { sandbox: { stdout: string } }).sandbox.stdout, 'runtime-sandbox-ok');
  const events = await runtime.events.read((event) => event.type.startsWith('sandbox.'));
  assert.equal(events.some((event) => event.type === 'sandbox.created'), true);
  assert.equal(events.some((event) => event.type === 'sandbox.destroyed'), true);
}));


test('runtime destroys a sandbox when policy validation rejects the command', async () => withWorkspace(async (workspace) => {
  const runtime = new HelixRuntime({ dataDirectory: workspace });
  await assert.rejects(() => runtime.execute({ goal: 'reject unsafe sandbox request', sandbox: { enabled: true, backend: 'local', policy: { workspacePath: workspace, allowedExecutables: [] }, command: { command: process.execPath, args: [] } } }), /not allowlisted/);
  const sandboxes = runtime.sandbox.list();
  assert.equal(sandboxes.length, 1);
  assert.equal(sandboxes[0]?.status, 'destroyed');
}));
