import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

test('cli uses structured verification commands and persists learning state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-learning-'));
  try {
    const script = join(directory, 'verify.mjs');
    await writeFile(script, `process.stdout.write('verified')`, 'utf8');
    const verify = JSON.stringify([{ name: 'node-verify', executable: process.execPath, args: [script], cwd: directory }]);
    const env = {
      HELIX_DATA_DIR: directory,
      HELIX_CODE_ADAPTER: 'deterministic',
      HELIX_CODE_CWD: directory,
      HELIX_CODE_WORKSPACE_ROOT: directory,
      HELIX_CODE_VERIFY_JSON: verify,
    };
    const result = await cli(['code', 'run', 'Verify feature', '--json'], env);
    assert.equal(result.code, 0, result.stderr);
    const session = JSON.parse(result.stdout) as { status: string; id: string };
    assert.equal(session.status, 'completed');
    await access(join(directory, 'learning.json'));
    const inspected = await cli(['code', 'session', session.id, '--json'], env);
    const evidence = (JSON.parse(inspected.stdout) as { evidence: Array<{ type: string; data: Record<string, unknown> }> }).evidence;
    const testEvidence = evidence.find((item) => item.type === 'test');
    assert.ok(testEvidence);
    assert.equal((testEvidence?.data.commands as Array<{ command: string; exitCode: number }>)[0]?.exitCode, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
