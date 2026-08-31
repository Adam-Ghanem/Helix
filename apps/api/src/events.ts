import type { EventEnvelope } from '../../../packages/core/src/index.js';
import type { EventStore } from '../../../packages/durable/src/index.js';

export interface EventPage {
  events: EventEnvelope[];
  sequence: number;
  hasMore: boolean;
}

export function parseSequence(value: string | undefined, name: string): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative safe integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return parsed;
}

export function parseLimit(value: string | undefined, options: { defaultValue: number; max: number }): number {
  const defaultValue = positiveSafeInteger(options.defaultValue, 'default limit');
  const max = positiveSafeInteger(options.max, 'maximum limit');
  if (defaultValue > max) throw new Error('default limit must not exceed maximum limit');
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error(`limit must be a positive safe integer up to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`limit must be a positive safe integer up to ${max}`);
  return parsed;
}

export async function readEventsAfter(store: EventStore, after: number, limit: number): Promise<EventPage> {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative safe integer');
  const boundedLimit = positiveSafeInteger(limit, 'limit');
  const matching = await store.read((event) => event.sequence > after);
  const hasMore = matching.length > boundedLimit;
  return {
    events: matching.slice(0, boundedLimit).map((event) => structuredClone(event)),
    sequence: store.lastSequence,
    hasMore,
  };
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
