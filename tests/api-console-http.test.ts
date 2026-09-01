import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createHelixRequestHandler } from '../apps/api/src/routes.js';
import { HelixRuntime } from '../packages/runtime/src/index.js';

async function withApi(
  options: { corsOrigin?: string; apiKey?: string } = {},
  run: (baseUrl: string, runtime: HelixRuntime) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-api-console-'));
  const runtime = new HelixRuntime({ dataDirectory: directory });
  await runtime.init();
  const handler = createHelixRequestHandler({
    runtime,
    dashboardRoot: resolve('apps/dashboard'),
    security: {
      maxBodyBytes: 1_048_576,
      rateLimitPerMinute: 1_000,
      ...(options.corsOrigin ? { corsOrigin: options.corsOrigin } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    },
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`, runtime);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

test('API serves the first-party dashboard from the same origin without wildcard CORS by default', async () => {
  await withApi({}, async (baseUrl) => {
    const dashboard = await fetch(`${baseUrl}/`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await dashboard.text(), /Helix/i);
    assert.equal(dashboard.headers.get('access-control-allow-origin'), null);

    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('access-control-allow-origin'), null);
    const payload = await health.json() as { status: string; service: string };
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'helix-api');
  });
});

test('API emits only an explicitly configured CORS origin', async () => {
  await withApi({ corsOrigin: 'https://console.example.test' }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/v1/health`, { headers: { origin: 'https://console.example.test' } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('access-control-allow-origin'), 'https://console.example.test');

    const preflight = await fetch(`${baseUrl}/api/v1/executions`, { method: 'OPTIONS', headers: { origin: 'https://console.example.test' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://console.example.test');
  });
});

test('API refactor preserves existing snapshot routes and fixed dashboard paths do not expose arbitrary files', async () => {
  await withApi({}, async (baseUrl) => {
    const agents = await fetch(`${baseUrl}/api/v1/agents`);
    assert.equal(agents.status, 200);
    const agentsPayload = await agents.json() as { agents: unknown[] };
    assert.ok(Array.isArray(agentsPayload.agents));

    const executions = await fetch(`${baseUrl}/api/v1/executions`);
    assert.equal(executions.status, 200);
    assert.deepEqual(await executions.json(), { executions: [] });

    const traversal = await fetch(`${baseUrl}/dashboard/%2e%2e/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(await traversal.text(), /\"name\"\s*:\s*\"helix\"/);
  });
});

test('execution list returns current durable lifecycle state instead of the execution.started snapshot', async () => {
  await withApi({}, async (baseUrl, runtime) => {
    const completed = await runtime.execute({ goal: 'complete the console snapshot test' });
    assert.equal(completed.status, 'completed');

    const response = await fetch(`${baseUrl}/api/v1/executions`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { executions: Array<{ id: string; status: string; result?: unknown }> };
    const listed = payload.executions.find((execution) => execution.id === completed.id);
    assert.ok(listed);
    assert.equal(listed.status, 'completed');
    assert.deepEqual(listed.result, completed.result);
  });
});
