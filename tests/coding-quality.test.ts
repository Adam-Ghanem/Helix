import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedProcessRunner, HttpQualityModel, ModelJudge, ModelReviewer, VerificationRunner } from '../packages/coding/src/index.js';

test('verification runner executes structured bounded commands and fails on non-zero exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-quality-verify-'));
  try {
    const pass = join(directory, 'pass.mjs');
    const fail = join(directory, 'fail.mjs');
    await writeFile(pass, `process.stdout.write('ok')`, 'utf8');
    await writeFile(fail, `process.stderr.write('bad');process.exit(2)`, 'utf8');
    const processRunner = new BoundedProcessRunner({ allowedExecutables: [process.execPath], workspaceRoots: [directory], environmentKeys: [], maxStdoutBytes: 4096, maxStderrBytes: 4096 });
    const verification = new VerificationRunner({ runner: processRunner });
    const passed = await verification.run([{ name: 'pass', executable: process.execPath, args: [pass], cwd: directory }]);
    assert.equal(passed.passed, true);
    assert.equal(passed.commands[0]?.exitCode, 0);
    const failed = await verification.run([{ name: 'fail', executable: process.execPath, args: [fail], cwd: directory }]);
    assert.equal(failed.passed, false);
    assert.equal(failed.commands[0]?.exitCode, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('http quality model calls OpenAI-compatible chat completions and returns content', async () => {
  const requests: Array<{ authorization?: string | undefined; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '{"approved":true,"findings":[],"summary":"ok"}' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    const model = new HttpQualityModel({ endpoint: `http://127.0.0.1:${address.port}`, apiKey: 'test-key', model: 'quality-model', timeoutMs: 1000 });
    const result = await model.complete({ system: 'review', prompt: 'check', timeoutMs: 500 });
    assert.match(result, /approved/);
    assert.equal(requests[0]?.authorization, 'Bearer test-key');
    assert.equal((requests[0]?.body as { model?: string }).model, 'quality-model');
  } finally { server.close(); }
});

test('model reviewer and judge validate structured JSON and fail closed on invalid output', async () => {
  const reviewer = new ModelReviewer({ model: { complete: async () => '{"approved":false,"findings":[{"severity":"high","message":"unsafe"}],"summary":"needs fix"}' } });
  const review = await reviewer.review({ goal: 'x', output: 'implementation', evidence: [] });
  assert.equal(review.approved, false);
  assert.equal(review.findings[0]?.severity, 'high');

  const judge = new ModelJudge({ model: { complete: async () => '{"accepted":true,"reason":"good","requiredFixes":[],"confidence":1.7}' } });
  const verdict = await judge.judge({ goal: 'x', review, test: { passed: true, commands: [], summary: 'ok' }, evidence: [] });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.confidence, 1);

  const invalidReviewer = new ModelReviewer({ model: { complete: async () => 'not-json' } });
  const invalid = await invalidReviewer.review({ goal: 'x', output: 'implementation', evidence: [] });
  assert.equal(invalid.approved, false);
  assert.match(invalid.summary, /invalid/i);

  const invalidJudge = new ModelJudge({ model: { complete: async () => '{}' } });
  const invalidVerdict = await invalidJudge.judge({ goal: 'x', review, test: { passed: true, commands: [], summary: 'ok' }, evidence: [] });
  assert.equal(invalidVerdict.accepted, false);
  assert.equal(invalidVerdict.confidence, 0);
});
