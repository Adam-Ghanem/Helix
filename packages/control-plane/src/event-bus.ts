import { id, timestamp } from '../../core/src/index.js';
import type { ControlEvent, ControlPlaneEventHandler, ControlEventType } from './types.js';

export interface EventBusOptions { maxHistory?: number; clock?: () => string; }

export class EventBus {
  private readonly history: ControlEvent[] = [];
  private readonly subscriptions = new Map<string, { type?: ControlEventType; handler: ControlPlaneEventHandler }>();
  private readonly maxHistory: number;
  private readonly clock: () => string;

  constructor(options: EventBusOptions = {}) { this.maxHistory = Math.max(1, Math.floor(options.maxHistory ?? 2_000)); this.clock = options.clock ?? timestamp; }

  publish<T extends Record<string, unknown>>(input: Omit<ControlEvent<T>, 'eventId' | 'timestamp'> & { timestamp?: string }): ControlEvent<T> {
    const event: ControlEvent<T> = { ...input, eventId: id('cevent'), timestamp: input.timestamp ?? this.clock(), metadata: sanitize(input.metadata) as T };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    for (const subscription of this.subscriptions.values()) {
      if (subscription.type && subscription.type !== event.type) continue;
      try { void subscription.handler(event); } catch { /* subscriber failures do not stop event delivery */ }
    }
    return structuredClone(event);
  }

  subscribe(handler: ControlPlaneEventHandler, type?: ControlEventType): () => void {
    const subscriptionId = id('subscription');
    this.subscriptions.set(subscriptionId, { ...(type ? { type } : {}), handler });
    return () => { this.subscriptions.delete(subscriptionId); };
  }

  list(options: { type?: ControlEventType; since?: string; limit?: number } = {}): ControlEvent[] {
    const filtered = this.history.filter((event) => (!options.type || event.type === options.type) && (!options.since || event.timestamp >= options.since));
    return structuredClone(filtered.slice(-Math.max(1, Math.floor(options.limit ?? this.maxHistory))));
  }

  clear(): void { this.history.length = 0; }
  get size(): number { return this.history.length; }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = /(secret|token|password|api[_-]?key|private[_-]?key)/i.test(key) ? '[REDACTED]' : sanitize(item);
  return output;
}
