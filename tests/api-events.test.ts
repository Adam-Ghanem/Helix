import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseLimit, parseSequence, readEventsAfter } from '../apps/api/src/events.js';
import { createHelixRequestHandler } from '../apps/api/src/routes.js';
import { EventStore } from '../packages/durable/src/index.js';
import { HelixRuntime } from '../packages/runtime/src/index.js';

test('event query parsers reject unsafe cursors and limits', () => {
  assert.equal(parseSequence(undefined, 'after'), 0);
  assert.equal(parseSequence('0', 'after'), 0);
  assert.equal(parseSequence('42', 'after'), 42);
  for (const invalid of ['-1', '1.5', 'x', '9007199254740992', '']) {
    assert.throws(() => parseSequence(invalid, 'after'), /after/i);
  }

  assert.equal(parseLimit(undefined, { defaultValue: 200, max: 1_000 }), 200);
  assert.equal(parseLimit('1000', { defaultValue: 200, max: 1_000 }), 1_000);
  for (const invalid of ['0', '-1', '1.5', '1001', 'x', '9007199254740992', '']) {
    assert.throws(() => parseLimit(invalid, { defaultValue: 200, max: 1_000 }), /limit/i);
  }
});

test('readEventsAfter returns ordered events strictly after the cursor and reports more data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-events-query-'));
  try {
    const store = new EventStore({ directory });
    await store.init();
    for (let index = 1; index <= 5; index += 1) {
      await store.append({ type: `test.${index}`, payload: { index } });
    }
    const page = await readEventsAfter(store, 2, 2);
    assert.deepEqual(page.events.map((event) => event.sequence), [3, 4]);
    assert.equal(page.sequence, 5);
    assert.equal(page.hasMore, true);

    const last = await readEventsAfter(store, 4, 10);
    assert.deepEqual(last.events.map((event) => event.sequence), [5]);
    assert.equal(last.hasMore, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GET /api/v1/events applies bounded after and limit query semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-events-http-'));
  const runtime = new HelixRuntime({ dataDirectory: directory });
  await runtime.init();
  for (let index = 1; index <= 4; index += 1) await runtime.events.append({ type: `console.${index}`, payload: { index } });
  const handler = createHelixRequestHandler({
    runtime,
    dashboardRoot: resolve('apps/dashboard'),
    security: { maxBodyBytes: 1_048_576, rateLimitPerMinute: 1_000 },
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/api/v1/events?after=1&limit=2`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { events: Array<{ sequence: number }>; sequence: number; hasMore: boolean };
    assert.deepEqual(payload.events.map((event) => event.sequence), [2, 3]);
    assert.equal(payload.sequence, 4);
    assert.equal(payload.hasMore, true);

    for (const query of ['after=-1', 'after=1.5', 'limit=0', 'limit=1001']) {
      const invalid = await fetch(`${baseUrl}/api/v1/events?${query}`);
      assert.equal(invalid.status, 400, query);
    }
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
