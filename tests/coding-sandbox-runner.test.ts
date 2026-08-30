import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutableSandbox, SandboxExecutionRequest, SandboxExecutionResult } from '../packages/sandbox/src/index.js';
import { SandboxProcessRunner } from '../packages/coding/src/index.js';

test('sandbox process runner preserves coding runner contract over isolated execution', async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string; environment: Record<string, string>; stdin?: string }> = [];
  const executeRequest = async (request: SandboxExecutionRequest): Promise<SandboxExecutionResult> => {
    calls.push({
      command: request.command,
      args: [...request.args],
      cwd: request.cwd ?? '.',
      environment: { ...(request.environment ?? {}) },
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
    });
    return {
      backend: 'bubblewrap', isolated: true, command: request.command, args: [...request.args], exitCode: 0,
      stdout: 'ok', stderr: '', timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false,
    };
  };
  const sandbox: ExecutableSandbox = {
    backend: 'bubblewrap',
    isolated: true,
    execute: (command, args, cwd = '.', environment = {}) => executeRequest({ command, args, cwd, environment }),
    executeRequest,
  };
  const runner = new SandboxProcessRunner({ sandbox });
  const result = await runner.run({ executable: '/usr/bin/tool', args: ['--json'], cwd: '/workspace/project', environment: { TOKEN: 'x' }, stdin: 'prompt', timeoutMs: 1000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.cancelled, false);
  assert.equal(result.executable, '/usr/bin/tool');
  assert.equal(result.cwd, '/workspace/project');
  assert.deepEqual(calls[0], { command: '/usr/bin/tool', args: ['--json'], cwd: '/workspace/project', environment: { TOKEN: 'x' }, stdin: 'prompt' });
});

test('sandbox process runner rejects a request cancelled before execution', async () => {
  let executed = false;
  const executeRequest = async (request: SandboxExecutionRequest): Promise<SandboxExecutionResult> => {
    executed = true;
    return { backend: 'process', isolated: false, command: request.command, args: [...request.args], exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false };
  };
  const sandbox: ExecutableSandbox = {
    backend: 'process',
    isolated: false,
    execute: (command, args, cwd = '.', environment = {}) => executeRequest({ command, args, cwd, environment }),
    executeRequest,
  };
  const controller = new AbortController();
  controller.abort();
  const runner = new SandboxProcessRunner({ sandbox });
  await assert.rejects(() => runner.run({ executable: '/usr/bin/tool', args: [], cwd: '/tmp', timeoutMs: 1000, signal: controller.signal }), /cancelled before start/i);
  assert.equal(executed, false);
});
