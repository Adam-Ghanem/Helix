import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('cli exposes coding sessions, hooks, and sandbox status with valid json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-code-'));
  try {
    const env = { HELIX_DATA_DIR: directory, HELIX_CODE_ADAPTER: 'deterministic' };
    const help = await cli(['help'], env);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /helix code run/i);
    assert.match(help.stdout, /helix hooks list/i);
    assert.match(help.stdout, /helix sandbox status/i);

    const sandbox = await cli(['sandbox', 'status', '--json'], env);
    assert.equal(sandbox.code, 0, sandbox.stderr);
    const sandboxStatus = JSON.parse(sandbox.stdout) as { platform: string; strictAvailable: boolean; backend: string };
    assert.equal(sandboxStatus.platform, process.platform);
    assert.equal(typeof sandboxStatus.strictAvailable, 'boolean');
    assert.ok(['bubblewrap', 'unavailable'].includes(sandboxStatus.backend));

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

test('external coding adapters require an explicit valid sandbox mode and host mode remains opt-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-code-sandbox-'));
  try {
    const script = join(directory, 'agent.mjs');
    await writeFile(script, `let input='';for await (const chunk of process.stdin) input+=chunk;process.stdout.write(JSON.stringify({changedFiles:[],commands:[],prompt:input}))`, 'utf8');
    const common = {
      HELIX_DATA_DIR: join(directory, '.helix'),
      HELIX_CODE_WORKSPACE_ROOT: directory,
      HELIX_CODE_CWD: directory,
      HELIX_CODE_EXECUTABLE: process.execPath,
      HELIX_CODE_ARGS: JSON.stringify([script]),
      HELIX_CODE_PROMPT_TRANSPORT: 'stdin',
    };

    const invalid = await cli(['code', 'run', 'test sandbox mode', '--adapter', 'generic', '--json'], { ...common, HELIX_CODE_SANDBOX: 'invalid' });
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /HELIX_CODE_SANDBOX/i);

    const host = await cli(['code', 'run', 'host opt in', '--adapter', 'generic', '--json'], { ...common, HELIX_CODE_SANDBOX: 'host' });
    assert.equal(host.code, 0, host.stderr);
    assert.equal((JSON.parse(host.stdout) as { status: string }).status, 'completed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cli runs and resumes native Codex threads with bounded host sandbox semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-codex-'));
  try {
    const executable = join(directory, 'fake-codex.mjs');
    const capture = join(directory, 'codex-calls.jsonl');
    await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let input='';for await (const chunk of process.stdin) input+=chunk;
appendFileSync(process.env.HELIX_CODEX_CAPTURE, JSON.stringify({args:process.argv.slice(2),input})+'\\n');
const events=[
 {type:'thread.started',thread_id:'thread-cli-1'},
 {type:'item.completed',item:{id:'msg',type:'agent_message',text:'codex completed'}},
 {type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:5,reasoning_output_tokens:0}}
];
process.stdout.write(events.map(JSON.stringify).join('\\n'));
`, 'utf8');
    await chmod(executable, 0o755);
    const env = {
      HELIX_DATA_DIR: join(directory, '.helix'),
      HELIX_CODE_WORKSPACE_ROOT: directory,
      HELIX_CODE_CWD: directory,
      HELIX_CODE_SANDBOX: 'host',
      HELIX_CODEX_EXECUTABLE: executable,
      HELIX_CODEX_MODEL: 'codex-fixture-model',
      HELIX_CODEX_PROFILE: 'helix-test',
      HELIX_CODE_ENV_KEYS: 'HELIX_CODEX_CAPTURE',
      HELIX_CODEX_CAPTURE: capture,
    };

    const run = await cli(['code', 'run', 'Native Codex task', '--adapter', 'codex', '--json'], env);
    assert.equal(run.code, 0, run.stderr);
    const session = JSON.parse(run.stdout) as { id: string; status: string };
    assert.equal(session.status, 'completed');

    const resumed = await cli(['code', 'resume', session.id, '--adapter', 'codex', '--json'], env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal((JSON.parse(resumed.stdout) as { status: string }).status, 'completed');

    const calls = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; input: string });
    assert.deepEqual(calls[0]?.args, ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--model', 'codex-fixture-model', '--profile', 'helix-test', '-']);
    assert.match(calls[0]?.input ?? '', /Native Codex task/);
    assert.deepEqual(calls[1]?.args, ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--model', 'codex-fixture-model', '--profile', 'helix-test', 'resume', 'thread-cli-1', '-']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cli fails closed for invalid Codex executable and strict Codex without network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-cli-codex-policy-'));
  try {
    const relative = await cli(['code', 'run', 'codex', '--adapter', 'codex', '--json'], {
      HELIX_DATA_DIR: join(directory, '.relative'),
      HELIX_CODE_WORKSPACE_ROOT: directory,
      HELIX_CODE_CWD: directory,
      HELIX_CODE_SANDBOX: 'host',
      HELIX_CODEX_EXECUTABLE: 'codex',
    });
    assert.notEqual(relative.code, 0);
    assert.match(relative.stderr, /HELIX_CODEX_EXECUTABLE.*absolute/i);

    const noNetwork = await cli(['code', 'run', 'codex', '--adapter', 'codex', '--json'], {
      HELIX_DATA_DIR: join(directory, '.strict'),
      HELIX_CODE_WORKSPACE_ROOT: directory,
      HELIX_CODE_CWD: directory,
      HELIX_CODE_SANDBOX: 'strict',
      HELIX_CODE_SANDBOX_NETWORK: 'false',
      HELIX_CODEX_EXECUTABLE: process.execPath,
    });
    assert.notEqual(noNetwork.code, 0);
    assert.match(noNetwork.stderr, /Codex.*network|network.*Codex/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
