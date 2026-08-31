import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BubblewrapSandbox, UnsafeProcessSandbox } from '../packages/sandbox/src/index.js';

test('bubblewrap sandbox exposes trusted read-only binds without weakening workspace or network isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helix-sandbox-bind-'));
  try {
    const workspace = join(root, 'workspace');
    const artifact = join(root, 'artifact.mjs');
    await writeFile(artifact, 'export {};\n', 'utf8');

    const sandbox = new BubblewrapSandbox({
      workspace,
      allowedCommands: ['/usr/bin/printf'],
      bwrapExecutable: '/usr/bin/bwrap',
      runtimeReadOnlyPaths: ['/usr'],
      readOnlyBinds: [{ source: artifact, target: '/plugin/worker.mjs' }],
    });
    const plan = sandbox.plan('/usr/bin/printf', ['ok']);

    assert.equal(plan.isolated, true);
    assert.ok(plan.args.includes('--unshare-net'));
    assert.deepEqual(argumentPair(plan.args, '--bind'), [workspace, '/workspace']);
    assert.ok(hasTriplet(plan.args, '--ro-bind', artifact, '/plugin/worker.mjs'));
    assert.ok(!hasTriplet(plan.args, '--bind', artifact, '/plugin/worker.mjs'));

    assert.throws(() => new BubblewrapSandbox({
      workspace,
      allowedCommands: ['/usr/bin/printf'],
      bwrapExecutable: '/usr/bin/bwrap',
      runtimeReadOnlyPaths: ['/usr'],
      readOnlyBinds: [{ source: artifact, target: '/workspace/worker.mjs' }],
    }), /read.?only|target|workspace|protected/i);
    assert.throws(() => new BubblewrapSandbox({
      workspace,
      allowedCommands: ['/usr/bin/printf'],
      bwrapExecutable: '/usr/bin/bwrap',
      runtimeReadOnlyPaths: ['/usr'],
      readOnlyBinds: [{ source: artifact, target: 'plugin/worker.mjs' }],
    }), /absolute|target/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent process sandbox session exchanges bounded lines and closes without being reported as isolation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'helix-sandbox-session-'));
  try {
    const sandbox = new UnsafeProcessSandbox({ workspace, allowedCommands: [process.execPath] });
    const session = await sandbox.spawnSession({
      command: process.execPath,
      args: ['-e', `process.stdin.setEncoding('utf8'); let pending=''; process.stdin.on('data', chunk => { pending += chunk; for (;;) { const i = pending.indexOf('\\n'); if (i < 0) break; const line = pending.slice(0, i); pending = pending.slice(i + 1); process.stdout.write(line.toUpperCase() + '\\n'); } });`],
      maxFrameBytes: 64,
    });
    assert.equal(session.backend, 'process');
    assert.equal(session.isolated, false);

    const line = new Promise<string>((resolve) => session.onLine(resolve));
    await session.writeLine('hello');
    assert.equal(await line, 'HELLO');
    await assert.rejects(() => session.writeLine('x'.repeat(65)), /frame|64|large|limit/i);

    const exited = new Promise<{ exitCode: number; error?: string }>((resolve) => session.onExit(resolve));
    await session.close();
    const result = await exited;
    assert.equal(result.exitCode, 0);
    assert.equal(result.error, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('persistent sandbox session terminates on an oversized stdout frame instead of buffering without bound', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'helix-sandbox-session-frame-'));
  try {
    const sandbox = new UnsafeProcessSandbox({ workspace, allowedCommands: [process.execPath] });
    const session = await sandbox.spawnSession({
      command: process.execPath,
      args: ['-e', `process.stdout.write('x'.repeat(128) + '\\n'); setInterval(() => {}, 1000);`],
      maxFrameBytes: 32,
    });
    const exited = await new Promise<{ exitCode: number; error?: string }>((resolve) => session.onExit(resolve));
    assert.match(exited.error ?? '', /frame|32|large|limit/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function argumentPair(args: string[], flag: string): [string, string] | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const first = args[index + 1];
  const second = args[index + 2];
  return first !== undefined && second !== undefined ? [first, second] : undefined;
}

function hasTriplet(args: string[], flag: string, first: string, second: string): boolean {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === flag && args[index + 1] === first && args[index + 2] === second) return true;
  }
  return false;
}
