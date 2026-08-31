import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodexCliAdapter,
  type BoundedProcessRequest,
  type BoundedProcessResult,
  type ProcessRunner,
} from '../packages/coding/src/index.js';

class FixtureRunner implements ProcessRunner {
  readonly requests: BoundedProcessRequest[] = [];
  constructor(
    private readonly stdout: string,
    private readonly exitCode = 0,
    private readonly stderr = '',
    readonly isolated = false,
  ) {}

  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    this.requests.push(structuredClone(request));
    return {
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
    };
  }
}

const events = [
  { type: 'thread.started', thread_id: 'thread-123' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'edit-1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Implemented safely.' } },
  { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 10 } },
].map((event) => JSON.stringify(event)).join('\n');

const request = {
  sessionId: 'helix-session',
  goal: 'Implement parser',
  prompt: 'Implement parser',
  cwd: '/workspace/project',
  allowedTools: [],
  deniedTools: [],
  maxTurns: 12,
  timeoutMs: 60_000,
  context: [{ kind: 'memory', content: 'Prefer streaming parsers.' }],
};

test('Codex adapter uses Helix as the outer sandbox and parses JSONL evidence', async () => {
  const runner = new FixtureRunner(events, 0, '', true);
  const adapter = new CodexCliAdapter({ executable: '/usr/local/bin/codex', runner, isolation: 'helix' });

  const result = await adapter.run(request);

  assert.equal(result.success, true);
  assert.equal(result.output, 'Implemented safely.');
  assert.equal(result.sessionRef, 'thread-123');
  assert.deepEqual(result.changedFiles, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(result.commands, [{ command: 'pnpm test', exitCode: 0 }]);
  assert.deepEqual(result.usage, { tokens: 150 });
  assert.deepEqual(runner.requests[0]?.args, [
    'exec', '--json', '--color', 'never', '--dangerously-bypass-approvals-and-sandbox', '-',
  ]);
  assert.match(runner.requests[0]?.stdin ?? '', /Implement parser/);
  assert.match(runner.requests[0]?.stdin ?? '', /Helix context:/);
  assert.match(runner.requests[0]?.stdin ?? '', /Prefer streaming parsers/);
});

test('Codex adapter refuses sandbox bypass without a proven isolated runner', () => {
  assert.throws(
    () => new CodexCliAdapter({ executable: '/opt/codex', runner: new FixtureRunner(events), isolation: 'helix' }),
    /isolated|isolation|sandbox/i,
  );
});

test('Codex adapter keeps Codex workspace-write sandbox when Helix host mode is explicit', async () => {
  const runner = new FixtureRunner(events);
  const adapter = new CodexCliAdapter({ executable: '/opt/codex', runner, isolation: 'codex', model: 'gpt-5.6-codex', profile: 'helix' });

  await adapter.run(request);

  assert.deepEqual(runner.requests[0]?.args, [
    'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--model', 'gpt-5.6-codex', '--profile', 'helix', '-',
  ]);
  assert.ok(!runner.requests[0]?.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('Codex adapter resumes the native Codex thread and preserves parsed evidence', async () => {
  const runner = new FixtureRunner(events.replace('thread-123', 'thread-resumed'));
  const adapter = new CodexCliAdapter({ executable: '/opt/codex', runner, isolation: 'codex' });

  const result = await adapter.resume('thread-123', request);

  assert.equal(result.success, true);
  assert.equal(result.sessionRef, 'thread-resumed');
  assert.deepEqual(runner.requests[0]?.args, [
    'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', 'resume', 'thread-123', '-',
  ]);
});

test('Codex adapter fails closed on malformed JSONL or a turn failure', async () => {
  const malformed = new CodexCliAdapter({ executable: '/opt/codex', runner: new FixtureRunner('{not-json'), isolation: 'codex' });
  const malformedResult = await malformed.run(request);
  assert.equal(malformedResult.success, false);
  assert.match(malformedResult.error ?? '', /JSONL/i);

  const failedEvents = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-failed' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'model failed' } }),
  ].join('\n');
  const failed = new CodexCliAdapter({ executable: '/opt/codex', runner: new FixtureRunner(failedEvents), isolation: 'codex' });
  const failedResult = await failed.run(request);
  assert.equal(failedResult.success, false);
  assert.match(failedResult.error ?? '', /model failed/i);
});
