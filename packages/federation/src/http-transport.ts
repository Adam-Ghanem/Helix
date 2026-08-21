import type { FederationMessage, FederationRetryPolicy, FederationTransport } from './types.js';

export interface HttpFederationTransportOptions {
  endpoint: string;
  authToken?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  retry?: Partial<FederationRetryPolicy>;
  circuitBreaker?: { failureThreshold?: number; resetTimeoutMs?: number };
  fetchImpl?: typeof fetch;
  path?: string;
}

export class HttpFederationTransport implements FederationTransport {
  private readonly endpoint: string;
  private readonly authToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly retry: FederationRetryPolicy;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly path: string;
  private failures = 0;
  private openUntil = 0;
  private closed = false;
  private readonly handlers = new Set<(message: FederationMessage) => void>();

  constructor(options: HttpFederationTransportOptions) { if (!/^https?:\/\//.test(options.endpoint)) throw new Error('HTTP federation endpoint must use http(s)'); this.endpoint = options.endpoint.replace(/\/$/, ''); this.authToken = options.authToken; this.timeoutMs = Math.max(1, options.timeoutMs ?? 5_000); this.maxBodyBytes = Math.max(1_024, options.maxBodyBytes ?? 1_048_576); this.retry = { maxRetries: Math.max(0, Math.floor(options.retry?.maxRetries ?? 2)), baseDelayMs: Math.max(1, options.retry?.baseDelayMs ?? 50), maxDelayMs: Math.max(1, options.retry?.maxDelayMs ?? 2_000), ...(options.retry?.jitterMs !== undefined ? { jitterMs: Math.max(0, options.retry.jitterMs) } : {}) }; this.failureThreshold = Math.max(1, Math.floor(options.circuitBreaker?.failureThreshold ?? 3)); this.resetTimeoutMs = Math.max(1, options.circuitBreaker?.resetTimeoutMs ?? 10_000); this.fetchImpl = options.fetchImpl ?? fetch; this.path = options.path ?? '/api/v1/federation/messages'; }
  async send<T>(message: FederationMessage<T>): Promise<void> { await this.perform(message, false); }
  async request<T, R>(message: FederationMessage<T>, timeoutMs = this.timeoutMs): Promise<FederationMessage<R>> { return this.perform<T, FederationMessage<R>>(message, true, timeoutMs); }
  subscribe(handler: (message: FederationMessage) => void): () => void { if (this.closed) throw new Error('federation transport is closed'); this.handlers.add(handler); return () => this.handlers.delete(handler); }
  async close(): Promise<void> { this.closed = true; this.handlers.clear(); }
  circuitState(): { state: 'closed' | 'open'; failures: number; openUntil: number } { return { state: this.openUntil > Date.now() ? 'open' : 'closed', failures: this.failures, openUntil: this.openUntil }; }
  private async perform<T, R>(message: FederationMessage<T>, expectResponse: boolean, timeoutMs = this.timeoutMs): Promise<R> { if (this.closed) throw new Error('federation transport is closed'); if (this.openUntil > Date.now()) throw new Error('federation circuit breaker is open'); const body = JSON.stringify(message); if (Buffer.byteLength(body, 'utf8') > this.maxBodyBytes) throw new Error('federation message exceeds configured body limit'); const attempts = message.idempotencyKey ? this.retry.maxRetries + 1 : 1; let lastError: Error | undefined; for (let attempt = 0; attempt < attempts; attempt += 1) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { const response = await this.fetchImpl(`${this.endpoint}${this.path}`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-helix-message-id': message.messageId, 'x-helix-idempotency-key': message.idempotencyKey ?? message.messageId, ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}) }, body }); const text = await response.text(); if (Buffer.byteLength(text, 'utf8') > this.maxBodyBytes) throw new Error('federation response exceeds configured body limit'); if (!response.ok) throw new Error(`federation transport returned HTTP ${response.status}`); this.failures = 0; this.openUntil = 0; if (!expectResponse) return undefined as R; const parsed = JSON.parse(text) as FederationMessage; for (const handler of this.handlers) handler(structuredClone(parsed)); return parsed as R; } catch (error) { lastError = error instanceof Error && error.name === 'AbortError' ? new Error(`federation network timeout after ${timeoutMs}ms`) : error instanceof Error ? error : new Error(String(error)); const retryable = this.retryable(lastError); if (!retryable || attempt + 1 >= attempts) break; const delay = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * (2 ** attempt)); await new Promise((resolve) => setTimeout(resolve, delay)); } finally { clearTimeout(timer); } } this.failures += 1; if (this.failures >= this.failureThreshold) this.openUntil = Date.now() + this.resetTimeoutMs; throw lastError ?? new Error('federation transport failed'); }
  private retryable(error: Error): boolean { const message = error.message.toLowerCase(); return message.includes('timeout') || message.includes('http 408') || message.includes('http 425') || message.includes('http 429') || message.includes('http 500') || message.includes('http 502') || message.includes('http 503') || message.includes('http 504') || message.includes('network') || message.includes('fetch'); }
}
