import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'dist/apps/cli/src/index.js'), ...args], { env: { ...process.env, ...env }, shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject); child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test('cli exposes coding sessions and hook commands with valid json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-code-'));
  try {
    const env = { HELIX_DATA_DIR: directory, HELIX_CODE_ADAPTER: 'deterministic' };
    const help = await cli(['help'], env);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /helix code run/i);
    assert.match(help.stdout, /helix hooks list/i);

    const run = await cli(['code', 'run', 'Implement parser', '--json'], env);
    assert.equal(run.code, 0, run.stderr);
    const session = JSON.parse(run.stdout) as { id: string; status: string };
    assert.ok(session.id);
    assert.equal(session.status, 'completed');

    const inspect = await cli(['code', 'session', session.id, '--json'], env);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal((JSON.parse(inspect.stdout) as { session: { id: string } }).session.id, session.id);

    const list = await cli(['code', 'sessions', '--json'], env);
    assert.equal(list.code, 0, list.stderr);
    assert.ok((JSON.parse(list.stdout) as { sessions: unknown[] }).sessions.length >= 1);

    const hooks = await cli(['hooks', 'list', '--json'], env);
    assert.equal(hooks.code, 0, hooks.stderr);
    assert.ok(Array.isArray((JSON.parse(hooks.stdout) as { hooks: unknown[] }).hooks));

    const badPayload = await cli(['hooks', 'run', 'pre-task', '--session', session.id, '--payload', '{bad}', '--json'], env);
    assert.notEqual(badPayload.code, 0);
    assert.match(badPayload.stderr, /payload/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
