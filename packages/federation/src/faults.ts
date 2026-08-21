import type { FaultInjectionRule, FederationMessage, FederationTransport } from './types.js';

export class FaultInjectingTransport implements FederationTransport {
  private closed = false;
  constructor(private readonly inner: FederationTransport, private readonly rules: FaultInjectionRule[] = []) {}
  addRule(rule: FaultInjectionRule): void { this.rules.push({ ...rule }); }
  clearRules(): void { this.rules.length = 0; }
  async send<T>(message: FederationMessage<T>): Promise<void> { const rule = this.match(message); if (!rule) return this.inner.send(message); if (rule.action === 'crash') throw new Error('injected node crash'); if (rule.action === 'partition') throw new Error('injected network partition'); if (rule.action === 'drop') return; if (rule.action === 'delay') await new Promise((resolve) => setTimeout(resolve, Math.max(0, rule.delayMs ?? 1))); const next = rule.action === 'corrupt' ? this.corrupt(message) : message; await this.inner.send(next); if (rule.action === 'duplicate') await this.inner.send(structuredClone(message)); }
  request<T, R>(message: FederationMessage<T>, timeoutMs?: number): Promise<FederationMessage<R>> { return this.inner.request<T, R>(message, timeoutMs); }
  subscribe(handler: (message: FederationMessage) => void): () => void { return this.inner.subscribe(handler); }
  async close(): Promise<void> { this.closed = true; await this.inner.close(); }
  private match(message: FederationMessage): FaultInjectionRule | undefined { if (this.closed) throw new Error('federation transport is closed'); const rule = this.rules.find((candidate) => (candidate.messageId === undefined || candidate.messageId === message.messageId) && (candidate.messageType === undefined || candidate.messageType === message.type) && (candidate.remaining === undefined || candidate.remaining > 0)); if (rule?.remaining !== undefined) rule.remaining -= 1; return rule; }
  private corrupt<T>(message: FederationMessage<T>): FederationMessage<T> { return { ...structuredClone(message), signature: `${message.signature.slice(0, -1)}${message.signature.endsWith('0') ? '1' : '0'}` }; }
}
