import type { ProviderResult, ModelProvider } from '../../runtime/src/index.js';
import { ProviderRegistry } from '../../providers/src/index.js';
import type { ModelRouteDecision, ModelRouteRequest, ProviderHealth } from './types.js';

export interface ControlProvider extends ModelProvider {
  readonly id: string;
  readonly configured: boolean;
  models(): string[];
  capabilities(): string[];
  health(): Promise<ProviderHealth>;
}

export class ProviderCatalog {
  private readonly providers = new Map<string, ControlProvider>();
  register(provider: ControlProvider): void { if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`); this.providers.set(provider.id, provider); }
  get(id: string): ControlProvider { const provider = this.providers.get(id); if (!provider) throw new Error(`Unknown provider: ${id}`); return provider; }
  list(): ControlProvider[] { return [...this.providers.values()]; }
  async health(): Promise<ProviderHealth[]> { return Promise.all([...this.providers.values()].map((provider) => provider.health())); }
}

export class ModelRouter {
  constructor(readonly models: ProviderRegistry, readonly providers: ProviderCatalog) {}

  route(input: ModelRouteRequest): ModelRouteDecision {
    const capability = input.capabilities[0];
    if (!capability) throw new Error('at least one model capability is required');
    const maxLatencyMs = input.maxLatencyMs ?? Number.MAX_SAFE_INTEGER;
    const maxCostUsd = input.maxCostUsd ?? Number.MAX_SAFE_INTEGER;
    let candidates = this.models.list({ capability, availableOnly: true }).filter((model) => model.latencyMs <= maxLatencyMs && model.inputCostPerMillion <= maxCostUsd * 1_000_000);
    if (input.privateOnly) candidates = candidates.filter((model) => model.provider.toLowerCase().includes('local') || model.provider.toLowerCase().includes('deterministic'));
    candidates.sort((left, right) => left.latencyMs - right.latencyMs || left.inputCostPerMillion - right.inputCostPerMillion || left.id.localeCompare(right.id));
    const model = candidates[0];
    if (!model) throw new Error(`No model satisfies capability=${capability}`);
    return { model, rationale: [`capability=${capability}`, `latency<=${maxLatencyMs}ms`, `cost<=${maxCostUsd}USD`, input.privateOnly ? 'private-only filter applied' : 'provider policy permits configured models', 'deterministic stable ordering'] };
  }
}

export class RuntimeProviderAdapter implements ControlProvider {
  readonly id: string;
  readonly configured: boolean;
  constructor(private readonly runtimeProvider: ModelProvider, options: { id?: string; configured?: boolean } = {}) { this.id = options.id ?? runtimeProvider.name; this.configured = options.configured ?? !runtimeProvider.name.toLowerCase().includes('deterministic'); }
  get name(): string { return this.runtimeProvider.name; }
  models(): string[] { return [this.runtimeProvider.name]; }
  capabilities(): string[] { return ['text-generation', 'analysis']; }
  async health(): Promise<ProviderHealth> { return { id: this.id, name: this.name, available: true, configured: this.configured, message: this.configured ? 'provider configured' : 'deterministic local provider active' }; }
  execute(input: { goal: string; task: import('../../core/src/index.js').TaskRecord; agent: string }): Promise<ProviderResult> { return this.runtimeProvider.execute(input); }
}
