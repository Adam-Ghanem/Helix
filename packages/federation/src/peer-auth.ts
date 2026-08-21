import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FederationMessage, KeyProvider, PeerAuthenticator, PeerIdentity } from './types.js';

export class RotatingHmacKeyProvider implements KeyProvider {
  private current: { keyId: string; secret: string; algorithm: 'HMAC-SHA256' };
  private readonly old: Array<{ keyId: string; secret: string; algorithm: 'HMAC-SHA256' }> = [];
  constructor(initial: { keyId: string; secret: string }) { if (!initial.keyId || !initial.secret) throw new Error('initial federation key requires keyId and secret'); this.current = { ...initial, algorithm: 'HMAC-SHA256' }; }
  active(): { keyId: string; secret: string; algorithm: 'HMAC-SHA256' } { return { ...this.current }; }
  get(keyId: string): { keyId: string; secret: string; algorithm: 'HMAC-SHA256' } | undefined { const candidate = keyId === this.current.keyId ? this.current : this.old.find((key) => key.keyId === keyId); return candidate ? { ...candidate } : undefined; }
  previous(): Array<{ keyId: string; secret: string; algorithm: 'HMAC-SHA256' }> { return this.old.map((key) => ({ ...key })); }
  rotate(next: { keyId: string; secret: string }): void { if (!next.keyId || !next.secret) throw new Error('rotated federation key requires keyId and secret'); if (next.keyId === this.current.keyId) throw new Error('rotated keyId must differ from active keyId'); this.old.unshift({ ...this.current }); this.current = { ...next, algorithm: 'HMAC-SHA256' }; if (this.old.length > 2) this.old.length = 2; }
}

export class KeyProviderMessageSigner {
  readonly algorithm = 'HMAC-SHA256' as const;
  constructor(private readonly provider: KeyProvider) {}
  get keyId(): string { return this.provider.active().keyId; }
  sign(message: Omit<FederationMessage, 'signature'>): string { const key = this.provider.active(); return createHmac('sha256', key.secret).update(JSON.stringify(message)).digest('hex'); }
}

export class KeyProviderMessageVerifier implements PeerAuthenticator {
  constructor(private readonly provider: KeyProvider, private readonly maxClockSkewMs = 30_000, private readonly clock: () => number = Date.now) {}
  verify(message: FederationMessage): boolean { if (message.algorithm !== 'HMAC-SHA256' || !message.keyId) return false; const key = this.provider.get(message.keyId); if (!key || key.algorithm !== message.algorithm) return false; const unsigned = { ...message }; delete (unsigned as Partial<FederationMessage>).signature; const expected = createHmac('sha256', key.secret).update(JSON.stringify(unsigned)).digest('hex'); const actualBytes = Buffer.from(message.signature, 'hex'); const expectedBytes = Buffer.from(expected, 'hex'); if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return false; const created = Date.parse(message.timestamp); const expires = Date.parse(message.expiresAt); return message.schemaVersion === 1 && Number.isFinite(created) && Number.isFinite(expires) && expires > this.clock() && Math.abs(this.clock() - created) <= this.maxClockSkewMs; }
  authenticate(message: FederationMessage, peer: PeerIdentity): boolean { return message.sourceNodeId === peer.nodeId && message.keyId === peer.keyId && message.algorithm === peer.algorithm && this.verify(message); }
}
