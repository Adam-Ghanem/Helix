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

  async events(): Promise<Record<string, unknown>> {
    return this.request('/events');
  }

  async approvals(): Promise<Record<string, unknown>> {
    return this.request('/approvals');
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
