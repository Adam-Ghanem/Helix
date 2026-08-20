import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEnvelope, EventId, id, timestamp } from '../../core/src/index.js';

type EventPredicate = (event: EventEnvelope) => boolean;

export interface EventStoreOptions {
  directory: string;
  streamName?: string;
}

export interface Snapshot<T> {
  sequence: number;
  createdAt: string;
  state: T;
}

export class EventStore {
  private readonly file: string;
  private readonly snapshotFile: string;
  private sequence = 0;
  private events: EventEnvelope[] = [];
  private idempotency = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly options: EventStoreOptions) {
    const stream = options.streamName ?? 'helix';
    this.file = join(options.directory, `${stream}.events.jsonl`);
    this.snapshotFile = join(options.directory, `${stream}.snapshot.json`);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.options.directory, { recursive: true });
    try {
      const contents = await readFile(this.file, 'utf8');
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as EventEnvelope;
        this.events.push(event);
        this.sequence = Math.max(this.sequence, event.sequence);
        const key = this.idempotencyKey(event);
        if (key) this.idempotency.add(key);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async append<T>(
    input: Omit<EventEnvelope<T>, 'eventId' | 'sequence' | 'timestamp' | 'schemaVersion'> & { eventId?: EventId; idempotencyKey?: string },
  ): Promise<EventEnvelope<T>> {
    await this.init();
    const event = await this.enqueue(async () => {
      if (input.idempotencyKey && this.idempotency.has(input.idempotencyKey)) {
        const existing = this.events.find((candidate) => this.idempotencyKey(candidate) === input.idempotencyKey);
        if (existing) return existing as EventEnvelope<T>;
      }
      const next: EventEnvelope<T> = {
        eventId: input.eventId ?? id('evt'),
        sequence: ++this.sequence,
        timestamp: timestamp(),
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        ...(input.causationId ? { causationId: input.causationId } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        type: input.type,
        payload: input.payload,
        schemaVersion: 1,
      };
      await appendFile(this.file, `${JSON.stringify(next)}\n`, 'utf8');
      this.events.push(next);
      if (input.idempotencyKey) this.idempotency.add(input.idempotencyKey);
      return next;
    });
    return event;
  }

  async read(predicate?: EventPredicate): Promise<EventEnvelope[]> {
    await this.init();
    const copy = [...this.events];
    return predicate ? copy.filter(predicate) : copy;
  }

  async *stream(predicate?: EventPredicate): AsyncGenerator<EventEnvelope> {
    const events = await this.read(predicate);
    for (const event of events) yield event;
  }

  async replay<T>(initial: T, reducer: (state: T, event: EventEnvelope) => T, predicate?: EventPredicate): Promise<T> {
    let state = initial;
    for (const event of await this.read(predicate)) state = reducer(state, event);
    return state;
  }

  async snapshot<T>(state: T): Promise<Snapshot<T>> {
    await this.init();
    const snapshot: Snapshot<T> = { sequence: this.sequence, createdAt: timestamp(), state };
    await writeFile(this.snapshotFile, JSON.stringify(snapshot, null, 2), 'utf8');
    return snapshot;
  }

  async readSnapshot<T>(): Promise<Snapshot<T> | undefined> {
    await this.init();
    try {
      return JSON.parse(await readFile(this.snapshotFile, 'utf8')) as Snapshot<T>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  get lastSequence(): number {
    return this.sequence;
  }

  private idempotencyKey(event: EventEnvelope): string | undefined {
    return event.idempotencyKey;
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
