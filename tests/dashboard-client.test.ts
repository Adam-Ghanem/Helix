import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

interface SseFrame { id?: string; event?: string; data?: string }
interface ApiModule {
  ApiAuthError: new (...args: never[]) => Error;
  ResyncRequiredError: new (...args: never[]) => Error;
  createSseParser(onFrame: (frame: SseFrame) => void): { push(chunk: string | Uint8Array): void; finish(): void };
  createApiClient(options: { origin: string; getToken: () => string }): {
    json(path: string, options?: { method?: string; body?: unknown }): Promise<unknown>;
    streamEvents(options: { after: number; signal: AbortSignal; onOpen?: () => void; onEvent: (event: unknown) => void }): Promise<void>;
  };
}
interface ConsoleState {
  lastSequence: number;
  health: null | Record<string, unknown>;
  agents: unknown[];
  executions: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  telemetry: unknown;
  recentEvents: Array<Record<string, unknown>>;
  selectedExecution: unknown;
  selectedExecutionRefreshRequired: boolean;
}
interface StateModule {
  createConsoleState(): ConsoleState;
  applySnapshot(state: ConsoleState, snapshot: Record<string, unknown>): ConsoleState;
  applyHelixEvent(state: ConsoleState, event: Record<string, unknown>): { state: ConsoleState; resyncRequired: boolean };
  nextReconnectDelay(previous: number): number;
}

async function loadApi(): Promise<ApiModule> {
  return await import(pathToFileURL(resolve('apps/dashboard/src/api.js')).href) as ApiModule;
}
async function loadState(): Promise<StateModule> {
  return await import(pathToFileURL(resolve('apps/dashboard/src/state.js')).href) as StateModule;
}

test('dashboard SSE parser handles arbitrary chunk boundaries, UTF-8, multiple frames, and comments', async () => {
  const { createSseParser } = await loadApi();
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  const encoded = new TextEncoder().encode('id: 1\nevent: helix.event\ndata: {"message":"héllo 🚀"}\n\n: heartbeat\n\nid: 2\nevent: helix.event\ndata: {"ok":true}\n\n');
  for (const cut of [1, 4, 11, 19, 27, 36, 44, 53, 61, 72, 83, encoded.length]) {
    const previous = [0, 1, 4, 11, 19, 27, 36, 44, 53, 61, 72, 83][Math.max(0, [1, 4, 11, 19, 27, 36, 44, 53, 61, 72, 83, encoded.length].indexOf(cut))] ?? 0;
    parser.push(encoded.subarray(previous, cut));
  }
  parser.finish();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { id: '1', event: 'helix.event', data: '{"message":"héllo 🚀"}' });
  assert.deepEqual(frames[1], { id: '2', event: 'helix.event', data: '{"ok":true}' });
});

test('dashboard state applies snapshots, accepts ordered events, ignores duplicates, and requests resync on gaps', async () => {
  const { createConsoleState, applySnapshot, applyHelixEvent } = await loadState();
  let state = createConsoleState();
  state = applySnapshot(state, {
    health: { status: 'ok', sequence: 1 },
    agents: { agents: [{ id: 'agent-a' }] },
    executions: { executions: [{ id: 'ex-a', status: 'running' }] },
    approvals: { approvals: [{ id: 'ap-a', status: 'pending' }] },
    telemetry: { counters: [] },
    events: { sequence: 1, events: [{ sequence: 1, type: 'execution.started' }] },
  });
  assert.equal(state.lastSequence, 1);
  assert.equal(state.agents.length, 1);
  assert.equal(state.executions.length, 1);
  assert.equal(state.approvals.length, 1);

  const accepted = applyHelixEvent(state, {
    sequence: 2,
    type: 'execution.paused',
    executionId: 'ex-a',
    payload: { execution: { id: 'ex-a', status: 'paused' } },
  });
  assert.equal(accepted.resyncRequired, false);
  assert.equal(accepted.state.lastSequence, 2);
  assert.equal(accepted.state.executions[0]?.status, 'paused');

  const duplicate = applyHelixEvent(accepted.state, {
    sequence: 2,
    type: 'execution.paused',
    executionId: 'ex-a',
    payload: { execution: { id: 'ex-a', status: 'paused' } },
  });
  assert.equal(duplicate.resyncRequired, false);
  assert.equal(duplicate.state.recentEvents.length, accepted.state.recentEvents.length);

  const gap = applyHelixEvent(accepted.state, { sequence: 4, type: 'execution.completed', executionId: 'ex-a', payload: {} });
  assert.equal(gap.resyncRequired, true);
  assert.equal(gap.state.lastSequence, 2);
});

test('dashboard state caps recent events and updates approval lifecycle without inventing task state', async () => {
  const { createConsoleState, applySnapshot, applyHelixEvent } = await loadState();
  let state = applySnapshot(createConsoleState(), {
    health: { sequence: 0 },
    approvals: { approvals: [{ id: 'ap-a', status: 'pending' }] },
    events: { sequence: 0, events: [] },
  });
  for (let sequence = 1; sequence <= 205; sequence += 1) {
    const result = applyHelixEvent(state, {
      sequence,
      type: sequence === 1 ? 'approval.approved' : sequence === 2 ? 'task.completed' : 'telemetry.changed',
      executionId: sequence === 2 ? 'ex-a' : undefined,
      payload: sequence === 1 ? { id: 'ap-a', status: 'approved' } : { value: sequence },
    });
    assert.equal(result.resyncRequired, false);
    state = result.state;
  }
  assert.equal(state.recentEvents.length, 200);
  assert.equal(state.recentEvents[0]?.sequence, 6);
  assert.equal(state.approvals.some((approval) => approval.id === 'ap-a'), false);
  assert.equal(state.selectedExecutionRefreshRequired, false);

  state = { ...state, selectedExecution: { execution: { id: 'ex-a' } } };
  const taskEvent = applyHelixEvent(state, {
    sequence: 206,
    type: 'task.completed',
    executionId: 'ex-a',
    taskId: 'task-a',
    payload: { task: { id: 'task-a', status: 'completed' } },
  });
  assert.equal(taskEvent.state.selectedExecutionRefreshRequired, true);
});

test('dashboard reconnect delay is bounded exponential backoff', async () => {
  const { nextReconnectDelay } = await loadState();
  assert.equal(nextReconnectDelay(0), 500);
  assert.equal(nextReconnectDelay(500), 1_000);
  assert.equal(nextReconnectDelay(1_000), 2_000);
  assert.equal(nextReconnectDelay(8_000), 10_000);
  assert.equal(nextReconnectDelay(10_000), 10_000);
});

test('dashboard API client keeps credentials out of URLs and surfaces auth/resync errors', async () => {
  const { createApiClient, ApiAuthError, ResyncRequiredError } = await loadApi();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      requests.push({ url, headers });
      if (url.includes('/auth-test')) return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } });
      if (url.includes('/events/stream')) return new Response('{"error":"resync_required"}', { status: 409, headers: { 'content-type': 'application/json' } });
      return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const client = createApiClient({ origin: 'https://helix.example.test', getToken: () => 'top-secret' });
    assert.deepEqual(await client.json('/health'), { status: 'ok' });
    assert.equal(requests[0]?.url, 'https://helix.example.test/api/v1/health');
    assert.equal(requests[0]?.url.includes('top-secret'), false);
    assert.equal(requests[0]?.headers.get('authorization'), 'Bearer top-secret');

    await assert.rejects(() => client.json('/auth-test'), (error: unknown) => error instanceof ApiAuthError);
    const controller = new AbortController();
    await assert.rejects(
      () => client.streamEvents({ after: 7, signal: controller.signal, onEvent: () => undefined }),
      (error: unknown) => error instanceof ResyncRequiredError,
    );
    const streamRequest = requests.find((request) => request.url.includes('/events/stream'))!;
    assert.match(streamRequest.url, /after=7/);
    assert.equal(streamRequest.url.includes('top-secret'), false);
    assert.equal(streamRequest.headers.get('authorization'), 'Bearer top-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
