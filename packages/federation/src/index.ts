import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export * from './types.js';
export * from './node-registry.js';
export * from './messages.js';
export * from './peer-auth.js';
export * from './leases.js';
export * from './transport.js';
export * from './http-transport.js';
export * from './faults.js';
export * from './router.js';
export * from './coordinator.js';
export * from './worker.js';
export * from './outbox.js';
export * from './runtime.js';

export interface LegacyFederationNode {
  id: string;
  endpoint: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'quarantined';
  lastHeartbeat?: string;
}

export interface LegacyFederationMessage<T> {
  id: string;
  from: string;
  to: string;
  createdAt: string;
  expiresAt: string;
  nonce: string;
  payload: T;
  signature: string;
}

/** Backward-compatible M11 signing registry. New code should use NodeRegistry and FederationCoordinator. */
export class FederationRegistry {
  private readonly nodes = new Map<string, LegacyFederationNode>();
  private readonly seen = new Set<string>();
  register(node: LegacyFederationNode): void { if (!/^https?:\/\//.test(node.endpoint)) throw new Error('Federation endpoint must use http(s)'); this.nodes.set(node.id, { ...node, capabilities: [...new Set(node.capabilities)] }); }
  heartbeat(nodeId: string, at = new Date().toISOString()): void { const node = this.nodes.get(nodeId); if (!node) throw new Error(`Unknown federation node: ${nodeId}`); node.status = 'online'; node.lastHeartbeat = at; }
  list(): LegacyFederationNode[] { return [...this.nodes.values()].map((node) => structuredClone(node)); }
  sign<T>(from: string, to: string, payload: T, secret: string, ttlMs = 30_000): LegacyFederationMessage<T> { const message = { id: randomUUID(), from, to, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString(), nonce: randomUUID(), payload }; return { ...message, signature: this.signature(message, secret) }; }
  verify<T>(message: LegacyFederationMessage<T>, secret: string, now = Date.now()): boolean { if (Date.parse(message.expiresAt) <= now || this.seen.has(message.id)) return false; const { signature, ...unsigned } = message; const expected = this.signature(unsigned, secret); const expectedBytes = Buffer.from(expected); const signatureBytes = Buffer.from(signature); const valid = expectedBytes.length === signatureBytes.length && timingSafeEqual(expectedBytes, signatureBytes); if (valid) this.seen.add(message.id); return valid; }
  private signature<T>(message: Omit<LegacyFederationMessage<T>, 'signature'>, secret: string): string { return createHmac('sha256', secret).update(JSON.stringify(message)).digest('hex'); }
}
