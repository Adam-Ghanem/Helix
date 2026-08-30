import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedProcessRunner, ClaudeCodeAdapter, DeterministicCodingAdapter, GenericCliAdapter } from '../packages/coding/src/index.js';

async function fixture(directory: string): Promise<string> {
  const file = join(directory, 'fixture.mjs');
  await writeFile(file, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const payload={argv:process.argv.slice(2),input,secret:process.env.TEST_ALLOWED??null,hidden:process.env.TEST_HIDDEN??null};process.stdout.write(JSON.stringify(payload));});`, 'utf8');
  await chmod(file, 0o755);
  return file;
}

function request(cwd: string) {
  return { sessionId: 'session-1', goal: 'change code', prompt: 'implement safely', cwd, allowedTools: [], deniedTools: [], maxTurns: 4, timeoutMs: 2_000, context: [] };
}

test('bounded process runner enforces executable, cwd and environment boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-runner-'));
  try {
    const script = await fixture(directory);
    const runner = new BoundedProcessRunner({ allowedExecutables: [process.execPath], workspaceRoots: [directory], environmentKeys: ['TEST_ALLOWED'], maxStdoutBytes: 4096, maxStderrBytes: 4096, killGraceMs: 20 });
    await assert.rejects(() => runner.run({ executable: '/bin/sh', args: [], cwd: directory, timeoutMs: 100 }), /allowlisted/i);
    await assert.rejects(() => runner.run({ executable: process.execPath, args: [script], cwd: tmpdir(), timeoutMs: 100 }), /allowed root/i);
    const result = await runner.run({ executable: process.execPath, args: [script], cwd: directory, environment: { TEST_ALLOWED: 'yes', TEST_HIDDEN: 'no' }, stdin: 'hello', timeoutMs: 1_000 });
    const payload = JSON.parse(result.stdout) as { input: string; secret: string | null; hidden: string | null };
    assert.equal(payload.input, 'hello');
    assert.equal(payload.secret, 'yes');
    assert.equal(payload.hidden, null);
    assert.equal(result.timedOut, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded process runner truncates output and terminates timeouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-runner-limits-'));
  try {
    const noisy = join(directory, 'noisy.mjs');
    await writeFile(noisy, `process.stdout.write('x'.repeat(5000));`, 'utf8');
    const sleepy = join(directory, 'sleepy.mjs');
    await writeFile(sleepy, `setTimeout(()=>process.stdout.write('late'),5000);`, 'utf8');
    const runner = new BoundedProcessRunner({ allowedExecutables: [process.execPath], workspaceRoots: [directory], environmentKeys: [], maxStdoutBytes: 128, maxStderrBytes: 128, killGraceMs: 10 });
    const noisyResult = await runner.run({ executable: process.execPath, args: [noisy], cwd: directory, timeoutMs: 1_000 });
    assert.equal(noisyResult.stdoutTruncated, true);
    assert.ok(Buffer.byteLength(noisyResult.stdout) <= 128);
    const timeoutResult = await runner.run({ executable: process.execPath, args: [sleepy], cwd: directory, timeoutMs: 20 });
    assert.equal(timeoutResult.timedOut, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic cli adapter supports stdin and structured parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-generic-adapter-'));
  try {
    const script = await fixture(directory);
    const runner = new BoundedProcessRunner({ allowedExecutables: [process.execPath], workspaceRoots: [directory], environmentKeys: [], maxStdoutBytes: 4096, maxStderrBytes: 4096 });
    const adapter = new GenericCliAdapter({ name: 'fixture', runner, executable: process.execPath, staticArgs: [script], promptTransport: 'stdin', parse: (stdout) => ({ structured: JSON.parse(stdout) as Record<string, unknown>, changedFiles: ['src/a.ts'] }) });
    const result = await adapter.run(request(directory));
    assert.equal(result.success, true);
    assert.equal((result.structured as { input?: string }).input, 'implement safely');
    assert.deepEqual(result.changedFiles, ['src/a.ts']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('claude adapter uses documented print/json mode without bypass flags', () => {
  const adapter = new ClaudeCodeAdapter({ executable: '/usr/local/bin/claude', runner: {} as never });
  const args = adapter.argumentsFor(request('/workspace'));
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('json'));
  assert.ok(!args.some((arg) => /dangerously|bypass/i.test(arg)));
});

test('deterministic coding adapter provides a local provider-neutral harness fallback', async () => {
  const result = await new DeterministicCodingAdapter().run(request(process.cwd()));
  assert.equal(result.success, true);
  assert.equal(result.adapter, 'deterministic');
});
