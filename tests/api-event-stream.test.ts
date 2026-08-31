import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { EventStreamHub, parseResumeCursor } from '../apps/api/src/event-stream.js';
import { createHelixRequestHandler } from '../apps/api/src/routes.js';
import { HelixRuntime } from '../packages/runtime/src/index.js';

interface RunningApi {
  baseUrl: string;
  runtime: HelixRuntime;
  hub: EventStreamHub;
  close(): Promise<void>;
}

async function startApi(options: { apiKey?: string; replayMax?: number; pollMs?: number; heartbeatMs?: number; maxClients?: number } = {}): Promise<RunningApi> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-event-stream-'));
  const runtime = new HelixRuntime({ dataDirectory: directory });
  await runtime.init();
  const hub = new EventStreamHub({
    store: runtime.events,
    options: {
      replayMax: options.replayMax ?? 1_000,
      pollMs: options.pollMs ?? 10,
      heartbeatMs: options.heartbeatMs ?? 50,
      maxClients: options.maxClients ?? 64,
      maxPendingBytes: 262_144,
    },
  });
  const handler = createHelixRequestHandler({
    runtime,
    dashboardRoot: resolve('apps/dashboard'),
    eventStream: hub,
    security: {
      maxBodyBytes: 1_048_576,
      rateLimitPerMinute: 10_000,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    },
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtime,
    hub,
    async close() {
      await hub.close();
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('resume cursor accepts one source and rejects conflicting Last-Event-ID/query cursors', () => {
  const request = { headers: {} } as never;
  assert.equal(parseResumeCursor(request, new URL('http://localhost/api/v1/events/stream')), 0);
  assert.equal(parseResumeCursor(request, new URL('http://localhost/api/v1/events/stream?after=7')), 7);
  const withHeader = { headers: { 'last-event-id': '8' } } as never;
  assert.equal(parseResumeCursor(withHeader, new URL('http://localhost/api/v1/events/stream')), 8);
  assert.equal(parseResumeCursor(withHeader, new URL('http://localhost/api/v1/events/stream?after=8')), 8);
  assert.throws(() => parseResumeCursor(withHeader, new URL('http://localhost/api/v1/events/stream?after=7')), /conflict|cursor/i);
});

test('protected event stream rejects missing or wrong bearer credentials', async () => {
  const api = await startApi({ apiKey: 'secret' });
  try {
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
      const response = await fetch(`${api.baseUrl}/api/v1/events/stream`, { headers });
      assert.equal(response.status, 401);
    }
  } finally {
    await api.close();
  }
});

test('event stream replays strictly after cursor and supports Last-Event-ID', async () => {
  const api = await startApi();
  try {
    for (let index = 1; index <= 3; index += 1) await api.runtime.events.append({ type: `stream.${index}`, payload: { index } });

    const query = await fetch(`${api.baseUrl}/api/v1/events/stream?after=1`);
    assert.equal(query.status, 200);
    assert.match(query.headers.get('content-type') ?? '', /text\/event-stream/);
    const queryFrames = await readEventFrames(query, 2);
    assert.deepEqual(queryFrames.map((frame) => frame.id), ['2', '3']);
    assert.deepEqual(queryFrames.map((frame) => JSON.parse(frame.data).sequence), [2, 3]);

    const header = await fetch(`${api.baseUrl}/api/v1/events/stream`, { headers: { 'last-event-id': '2' } });
    const headerFrames = await readEventFrames(header, 1);
    assert.equal(headerFrames[0]?.id, '3');
  } finally {
    await api.close();
  }
});

test('event stream rejects conflicting cursors and replay backlogs larger than configured maximum', async () => {
  const api = await startApi({ replayMax: 2 });
  try {
    for (let index = 1; index <= 3; index += 1) await api.runtime.events.append({ type: `backlog.${index}`, payload: { index } });
    const conflict = await fetch(`${api.baseUrl}/api/v1/events/stream?after=1`, { headers: { 'last-event-id': '2' } });
    assert.equal(conflict.status, 400);

    const overflow = await fetch(`${api.baseUrl}/api/v1/events/stream?after=0`);
    assert.equal(overflow.status, 409);
    assert.deepEqual(await overflow.json(), { error: 'resync_required' });
  } finally {
    await api.close();
  }
});

test('event stream emits live durable events in order and heartbeats are comments, not Helix events', async () => {
  const api = await startApi({ pollMs: 5, heartbeatMs: 15 });
  try {
    const controller = new AbortController();
    const responsePromise = fetch(`${api.baseUrl}/api/v1/events/stream?after=0`, { signal: controller.signal });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    buffer = await readUntil(reader, decoder, buffer, (text) => text.includes(': heartbeat\n\n'));
    assert.match(buffer, /: heartbeat\n\n/);
    assert.doesNotMatch(buffer, /event: helix\.event/);

    await api.runtime.events.append({ type: 'live.one', payload: { value: 1 } });
    await api.runtime.events.append({ type: 'live.two', payload: { value: 2 } });
    buffer = await readUntil(reader, decoder, buffer, (text) => countOccurrences(text, 'event: helix.event') >= 2);
    const ids = [...buffer.matchAll(/id: (\d+)\nevent: helix\.event/g)].map((match) => Number(match[1]));
    assert.deepEqual(ids.slice(-2), [1, 2]);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await api.close();
  }
});

test('event stream enforces active client cap and releases clients after disconnect', async () => {
  const api = await startApi({ maxClients: 1, heartbeatMs: 10 });
  try {
    const firstController = new AbortController();
    const first = await fetch(`${api.baseUrl}/api/v1/events/stream`, { signal: firstController.signal });
    assert.equal(first.status, 200);
    assert.equal(api.hub.clientCount, 1);

    const second = await fetch(`${api.baseUrl}/api/v1/events/stream`);
    assert.equal(second.status, 503);

    firstController.abort();
    await first.body?.cancel().catch(() => undefined);
    await waitFor(() => api.hub.clientCount === 0);
    assert.equal(api.hub.clientCount, 0);

    const thirdController = new AbortController();
    const third = await fetch(`${api.baseUrl}/api/v1/events/stream`, { signal: thirdController.signal });
    assert.equal(third.status, 200);
    thirdController.abort();
    await third.body?.cancel().catch(() => undefined);
  } finally {
    await api.close();
  }
});

async function readEventFrames(response: Response, count: number): Promise<Array<{ id: string; data: string }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    buffer = await readUntil(reader, decoder, buffer, (text) => countOccurrences(text, 'event: helix.event') >= count);
    return buffer.split('\n\n').flatMap((block) => {
      if (!block.includes('event: helix.event')) return [];
      const id = /^id: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return id && data ? [{ id, data }] : [];
    }).slice(0, count);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initial: string,
  predicate: (text: string) => boolean,
): Promise<string> {
  let buffer = initial;
  const deadline = Date.now() + 2_000;
  while (!predicate(buffer)) {
    if (Date.now() > deadline) throw new Error(`Timed out reading SSE stream: ${buffer}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), 500)),
    ]);
    if (result.done) throw new Error(`SSE stream closed early: ${buffer}`);
    buffer += decoder.decode(result.value, { stream: true });
  }
  return buffer;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for event-stream cleanup');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
