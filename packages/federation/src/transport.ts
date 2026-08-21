import type { FederationMessage, FederationTransport } from './types.js';

type Handler = (message: FederationMessage) => void;

export class InMemoryFederationNetwork {
  private readonly subscribers = new Map<string, Set<Handler>>();
  attach(nodeId: string, handler: Handler): () => void { const handlers = this.subscribers.get(nodeId) ?? new Set<Handler>(); handlers.add(handler); this.subscribers.set(nodeId, handlers); return () => { handlers.delete(handler); if (!handlers.size) this.subscribers.delete(nodeId); }; }
  deliver<T>(message: FederationMessage<T>): void { const destinations = message.destinationNodeId ? [message.destinationNodeId] : [...this.subscribers.keys()].filter((nodeId) => nodeId !== message.sourceNodeId); for (const nodeId of destinations) for (const handler of this.subscribers.get(nodeId) ?? []) queueMicrotask(() => handler(structuredClone(message))); }
}

export class InMemoryFederationTransport implements FederationTransport {
  private readonly handlers = new Set<Handler>();
  private readonly detach: () => void;
  private closed = false;
  constructor(readonly nodeId: string, private readonly network: InMemoryFederationNetwork = new InMemoryFederationNetwork(), private readonly defaultTimeoutMs = 2_000) { this.detach = network.attach(nodeId, (message) => { if (!this.closed) for (const handler of this.handlers) handler(message); }); }
  async send<T>(message: FederationMessage<T>): Promise<void> { if (this.closed) throw new Error('federation transport is closed'); this.network.deliver(message); }
  async request<T, R>(message: FederationMessage<T>, timeoutMs = this.defaultTimeoutMs): Promise<FederationMessage<R>> { if (this.closed) throw new Error('federation transport is closed'); return new Promise<FederationMessage<R>>((resolve, reject) => { const timer = setTimeout(() => { unsubscribe(); reject(new Error(`federation request timed out after ${timeoutMs}ms`)); }, timeoutMs); const unsubscribe = this.subscribe((candidate) => { if (candidate.correlationId !== message.correlationId || candidate.sourceNodeId === message.sourceNodeId) return; clearTimeout(timer); unsubscribe(); resolve(candidate as FederationMessage<R>); }); void this.send(message).catch((error: unknown) => { clearTimeout(timer); unsubscribe(); reject(error); }); }); }
  subscribe(handler: Handler): () => void { if (this.closed) throw new Error('federation transport is closed'); this.handlers.add(handler); return () => this.handlers.delete(handler); }
  async close(): Promise<void> { this.closed = true; this.handlers.clear(); this.detach(); }
}
