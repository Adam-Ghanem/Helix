import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { timestamp } from '../../core/src/index.js';
import type { FederationMessage, FederationMessageType, MessageSigner, MessageVerifier, ReplayStore } from './types.js';

export class MemoryReplayStore implements ReplayStore {
  private readonly messages = new Map<string, number>();
  has(messageId: string): boolean { return this.messages.has(messageId); }
  remember(messageId: string, expiresAt: number): void { this.messages.set(messageId, expiresAt); }
  purge(now = Date.now()): void { for (const [messageId, expiresAt] of this.messages) if (expiresAt <= now) this.messages.delete(messageId); }
}

export class HmacMessageSigner implements MessageSigner {
  constructor(private readonly secret: string) { if (!secret) throw new Error('message signing secret is required'); }
  sign(message: Omit<FederationMessage, 'signature'>): string { return createHmac('sha256', this.secret).update(JSON.stringify(message)).digest('hex'); }
}

export class HmacMessageVerifier implements MessageVerifier {
  constructor(private readonly secret: string, private readonly replay: ReplayStore = new MemoryReplayStore(), private readonly maxClockSkewMs = 30_000, private readonly clock: () => number = Date.now) { if (!secret) throw new Error('message verification secret is required'); }
  verify(message: FederationMessage): boolean {
    this.replay.purge(this.clock());
    const expiresAt = Date.parse(message.expiresAt); const createdAt = Date.parse(message.timestamp);
    if (message.schemaVersion !== 1 || !Number.isFinite(expiresAt) || !Number.isFinite(createdAt) || expiresAt <= this.clock() || Math.abs(this.clock() - createdAt) > this.maxClockSkewMs || this.replay.has(message.messageId)) return false;
    const unsigned = { ...message }; delete (unsigned as Partial<FederationMessage>).signature;
    const expected = new HmacMessageSigner(this.secret).sign(unsigned as Omit<FederationMessage, 'signature'>);
    const actualBytes = Buffer.from(message.signature, 'hex'); const expectedBytes = Buffer.from(expected, 'hex');
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return false;
    this.replay.remember(message.messageId, expiresAt); return true;
  }
}

export function createFederationMessage<T>(input: { type: FederationMessageType; sourceNodeId: string; destinationNodeId?: string; correlationId?: string; traceId?: string; payload: T; ttlMs?: number }, signer: MessageSigner, clock = Date.now): FederationMessage<T> {
  const now = clock();
  const unsigned = { messageId: randomUUID(), type: input.type, timestamp: new Date(now).toISOString(), sourceNodeId: input.sourceNodeId, ...(input.destinationNodeId ? { destinationNodeId: input.destinationNodeId } : {}), correlationId: input.correlationId ?? randomUUID(), traceId: input.traceId ?? randomUUID(), payload: structuredClone(input.payload), schemaVersion: 1 as const, expiresAt: new Date(now + (input.ttlMs ?? 30_000)).toISOString(), nonce: randomUUID() };
  return { ...unsigned, signature: signer.sign(unsigned) };
}

export function messageTimestamp(message: FederationMessage): string { return message.timestamp || timestamp(); }
