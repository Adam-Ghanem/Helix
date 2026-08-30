import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BubblewrapSandbox, SandboxManager, UnsafeProcessSandbox } from '../packages/sandbox/src/index.js';

test('bubblewrap sandbox builds a minimal read-only no-network plan with bounded resources and env allowlist', () => {
  const workspace = '/work/project';
  const sandbox = new BubblewrapSandbox({
    workspace,
    bwrapExecutable: '/usr/bin/bwrap',
    prlimitExecutable: '/usr/bin/prlimit',
    runtimeReadOnlyPaths: ['/usr', '/lib'],
    allowedCommands: ['/usr/bin/node'],
    allowedEnvironmentKeys: ['SAFE_TOKEN'],
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    memoryMb: 256,
    cpuSeconds: 10,
    maxProcesses: 32,
  });
  const plan = sandbox.plan('/usr/bin/node', ['script.js'], 'src', { SAFE_TOKEN: 'ok', SECRET: 'drop-me' });
  assert.equal(plan.backend, 'bubblewrap');
  assert.equal(plan.isolated, true);
  assert.equal(plan.executable, '/usr/bin/prlimit');
  assert.ok(plan.args.includes('--as=268435456'));
  assert.ok(plan.args.includes('--nproc=32'));
  assert.ok(plan.args.includes('--cpu=10'));
  const bwrapIndex = plan.args.indexOf('/usr/bin/bwrap');
  assert.ok(bwrapIndex > 0);
  const bwrapArgs = plan.args.slice(bwrapIndex + 1);
  assert.deepEqual(bwrapArgs.slice(0, 2), ['--die-with-parent', '--new-session']);
  assert.ok(bwrapArgs.includes('--unshare-net'));
  assert.ok(bwrapArgs.includes('--ro-bind'));
  assert.ok(bwrapArgs.includes('/usr'));
  assert.ok(bwrapArgs.includes('/lib'));
  assert.equal(hasMount(bwrapArgs, '--ro-bind', '/home'), false);
  assert.equal(hasMount(bwrapArgs, '--bind', '/home'), false);
  assert.equal(hasMount(bwrapArgs, '--ro-bind', '/root'), false);
  assert.equal(hasMount(bwrapArgs, '--bind', '/root'), false);
  assert.ok(bwrapArgs.includes('--dir'));
  assert.ok(bwrapArgs.includes('/home'));
  assert.ok(bwrapArgs.includes('--bind'));
  assert.ok(bwrapArgs.includes(workspace));
  assert.ok(bwrapArgs.includes('/workspace'));
  assert.ok(bwrapArgs.includes('--clearenv'));
  assert.ok(bwrapArgs.includes('SAFE_TOKEN'));
  assert.ok(bwrapArgs.includes('ok'));
  assert.equal(bwrapArgs.includes('SECRET'), false);
  assert.ok(bwrapArgs.includes('/workspace/src'));
  assert.equal(plan.timeoutMs, 5000);
  assert.equal(plan.maxOutputBytes, 4096);
});

test('strict sandbox manager refuses silent host-process fallback', async () => {
  const strict = new SandboxManager({
    workspace: '/tmp',
    allowedCommands: ['/usr/bin/node'],
    backendAvailability: { bubblewrap: false, prlimit: false },
  });
  await assert.rejects(() => strict.create(), /isolated sandbox.*unavailable/i);

  const explicitFallback = new SandboxManager({
    workspace: '/tmp',
    allowedCommands: ['/usr/bin/node'],
    backendAvailability: { bubblewrap: false, prlimit: false },
    allowUnsafeFallback: true,
  });
  const sandbox = await explicitFallback.create();
  assert.equal(sandbox instanceof UnsafeProcessSandbox, true);
  assert.equal(sandbox.isolated, false);
});

test('unsafe process fallback is bounded and opt-in, not reported as isolation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-sandbox-process-'));
  try {
    const script = join(directory, 'script.mjs');
    await writeFile(script, `process.stdout.write('x'.repeat(10000))`, 'utf8');
    const sandbox = new UnsafeProcessSandbox({
      workspace: directory,
      allowedCommands: [process.execPath],
      allowedEnvironmentKeys: [],
      timeoutMs: 2000,
      maxOutputBytes: 512,
    });
    const result = await sandbox.execute(process.execPath, [script], '.');
    assert.equal(result.isolated, false);
    assert.equal(result.backend, 'process');
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stdout), 512);
    assert.equal(result.stdoutTruncated, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function hasMount(args: string[], flag: '--bind' | '--ro-bind', source: string): boolean {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === flag && args[index + 1] === source) return true;
  }
  return false;
}
