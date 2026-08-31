import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEnvelope } from '../../../packages/core/src/index.js';
import type { EventStore } from '../../../packages/durable/src/index.js';
import { parseSequence, readEventsAfter } from './events.js';

export interface EventStreamOptions {
  replayMax?: number;
  pollMs?: number;
  heartbeatMs?: number;
  maxClients?: number;
  maxPendingBytes?: number;
}

export interface EventStreamHubOptions {
  store: EventStore;
  options?: EventStreamOptions;
}

interface EventStreamClient {
  id: number;
  response: ServerResponse;
  lastSequence: number;
  pendingBytes: number;
  closed: boolean;
  removeDrain: (() => void) | undefined;
}

const DEFAULT_REPLAY_MAX = 1_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_CLIENTS = 64;
const DEFAULT_MAX_PENDING_BYTES = 262_144;

export class EventStreamHub {
  private readonly store: EventStore;
  private readonly replayMax: number;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly maxClients: number;
  private readonly maxPendingBytes: number;
  private readonly clients = new Map<number, EventStreamClient>();
  private nextClientId = 1;
  private pollTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private pollRunning = false;
  private closed = false;

  constructor(input: EventStreamHubOptions) {
    this.store = input.store;
    const options = input.options ?? {};
    this.replayMax = boundedPositiveInteger(options.replayMax ?? DEFAULT_REPLAY_MAX, 'replayMax', 1_000);
    this.pollMs = boundedPositiveInteger(options.pollMs ?? DEFAULT_POLL_MS, 'pollMs', 60_000);
    this.heartbeatMs = boundedPositiveInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, 'heartbeatMs', 300_000);
    this.maxClients = boundedPositiveInteger(options.maxClients ?? DEFAULT_MAX_CLIENTS, 'maxClients', 4_096);
    this.maxPendingBytes = boundedPositiveInteger(options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES, 'maxPendingBytes', 16 * 1024 * 1024);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    if (this.closed) {
      writeJson(response, 503, { error: 'event_stream_closed' }, extraHeaders);
      return;
    }
    if (this.clients.size >= this.maxClients) {
      writeJson(response, 503, { error: 'event_stream_capacity' }, extraHeaders);
      return;
    }

    let cursor: number;
    try {
      cursor = parseResumeCursor(request, url);
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) }, extraHeaders);
      return;
    }

    const replay = await readEventsAfter(this.store, cursor, this.replayMax);
    if (replay.hasMore) {
      writeJson(response, 409, { error: 'resync_required' }, extraHeaders);
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...extraHeaders,
    });
    response.flushHeaders?.();

    const client: EventStreamClient = {
      id: this.nextClientId++,
      response,
      lastSequence: cursor,
      pendingBytes: 0,
      closed: false,
      removeDrain: undefined,
    };
    this.clients.set(client.id, client);

    const cleanup = (): void => this.removeClient(client.id, false);
    response.once('close', cleanup);
    response.once('error', cleanup);
    request.once('aborted', cleanup);

    for (const event of replay.events) {
      if (!this.sendEvent(client, event)) return;
    }
    this.startTimers();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    for (const client of [...this.clients.values()]) this.removeClient(client.id, true);
  }

  private startTimers(): void {
    if (!this.clients.size || this.closed) return;
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
      this.pollTimer.unref?.();
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.closed || !this.clients.size || this.pollRunning) return;
    this.pollRunning = true;
    try {
      const minimumSequence = Math.min(...[...this.clients.values()].map((client) => client.lastSequence));
      const events = await this.store.read((event) => event.sequence > minimumSequence);
      for (const event of events) {
        for (const client of [...this.clients.values()]) {
          if (event.sequence > client.lastSequence) this.sendEvent(client, event);
        }
      }
    } catch {
      // A transient durable-store read failure must not crash the API process.
      // The next poll retries from each client's durable sequence cursor.
    } finally {
      this.pollRunning = false;
    }
  }

  private heartbeat(): void {
    for (const client of [...this.clients.values()]) this.writeFrame(client, ': heartbeat\n\n');
  }

  private sendEvent(client: EventStreamClient, event: EventEnvelope): boolean {
    if (event.sequence <= client.lastSequence) return true;
    const frame = `id: ${event.sequence}\nevent: helix.event\ndata: ${JSON.stringify(event)}\n\n`;
    const sent = this.writeFrame(client, frame);
    if (sent) client.lastSequence = event.sequence;
    return sent;
  }

  private writeFrame(client: EventStreamClient, frame: string): boolean {
    if (client.closed || client.response.destroyed || client.response.writableEnded) {
      this.removeClient(client.id, false);
      return false;
    }
    const bytes = Buffer.byteLength(frame, 'utf8');
    const buffered = client.response.writableLength + client.pendingBytes;
    if (bytes > this.maxPendingBytes || buffered + bytes > this.maxPendingBytes) {
      this.removeClient(client.id, true);
      return false;
    }
    try {
      const accepted = client.response.write(frame);
      if (!accepted) {
        client.pendingBytes += bytes;
        if (!client.removeDrain) {
          const onDrain = (): void => {
            client.pendingBytes = 0;
            client.removeDrain?.();
            client.removeDrain = undefined;
          };
          client.response.on('drain', onDrain);
          client.removeDrain = () => client.response.off('drain', onDrain);
        }
      }
      return true;
    } catch {
      this.removeClient(client.id, true);
      return false;
    }
  }

  private removeClient(id: number, terminate: boolean): void {
    const client = this.clients.get(id);
    if (!client) return;
    client.closed = true;
    client.removeDrain?.();
    client.removeDrain = undefined;
    this.clients.delete(id);
    if (terminate && !client.response.destroyed && !client.response.writableEnded) client.response.destroy();
    if (!this.clients.size) this.stopTimers();
  }
}

export function parseResumeCursor(request: IncomingMessage, url: URL): number {
  const header = request.headers['last-event-id'];
  if (Array.isArray(header)) throw new Error('Last-Event-ID cursor must have exactly one value');
  const queryValues = url.searchParams.getAll('after');
  if (queryValues.length > 1) throw new Error('after cursor must have exactly one value');
  const query = queryValues[0];
  const headerCursor = header === undefined ? undefined : parseSequence(header, 'Last-Event-ID');
  const queryCursor = query === undefined ? undefined : parseSequence(query, 'after');
  if (headerCursor !== undefined && queryCursor !== undefined && headerCursor !== queryCursor) {
    throw new Error('resume cursor conflict between Last-Event-ID and after');
  }
  return headerCursor ?? queryCursor ?? 0;
}

function writeJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string>): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}
