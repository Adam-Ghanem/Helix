export interface HelixClientOptions {
  baseUrl: string;
}

export interface ExecutionInput {
  goal: string;
  budget?: Record<string, number>;
}

export class HelixClient {
  private readonly baseUrl: string;

  constructor(options: HelixClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request('/health');
  }

  async agents(): Promise<Record<string, unknown>> {
    return this.request('/agents');
  }

  async executions(): Promise<Record<string, unknown>> {
    return this.request('/executions');
  }

  async execute(input: ExecutionInput): Promise<Record<string, unknown>> {
    return this.request('/executions', { method: 'POST', body: JSON.stringify(input) });
  }

  async execution(id: string): Promise<Record<string, unknown>> {
    return this.request(`/executions/${encodeURIComponent(id)}`);
  }

  async pause(id: string): Promise<Record<string, unknown>> {
    return this.lifecycle(id, 'pause');
  }

  async resume(id: string): Promise<Record<string, unknown>> {
    return this.lifecycle(id, 'resume');
  }

  async cancel(id: string): Promise<Record<string, unknown>> {
    return this.lifecycle(id, 'cancel');
  }

  async retry(id: string): Promise<Record<string, unknown>> {
    return this.lifecycle(id, 'retry');
  }

  async checkpoint(id: string): Promise<Record<string, unknown>> {
    return this.lifecycle(id, 'checkpoint');
  }

  async events(): Promise<Record<string, unknown>> {
    return this.request('/events');
  }

  async recover(): Promise<Record<string, unknown>> {
    return this.request('/recover', { method: 'POST' });
  }

  async remember(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/memory', { method: 'POST', body: JSON.stringify(input) });
  }

  async recall(query: { q: string; namespace?: string; subject?: string; limit?: number }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ q: query.q, namespace: query.namespace ?? 'default', subject: query.subject ?? 'api-user', limit: String(query.limit ?? 20) });
    return this.request(`/memory/search?${params.toString()}`);
  }

  async telemetry(): Promise<Record<string, unknown>> {
    return this.request('/telemetry');
  }

  async approvals(): Promise<Record<string, unknown>> {
    return this.request('/approvals');
  }

  async approve(id: string): Promise<Record<string, unknown>> {
    return this.request(`/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  }

  async deny(id: string): Promise<Record<string, unknown>> {
    return this.request(`/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' });
  }

  private async lifecycle(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'checkpoint'): Promise<Record<string, unknown>> {
    return this.request(`/executions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Helix API error: ${response.status}`);
    return payload;
  }
}

export function createHelix(options: HelixClientOptions): HelixClient {
  return new HelixClient(options);
}
