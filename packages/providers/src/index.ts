export interface ProviderModel {
  id: string;
  provider: string;
  capabilities: string[];
  contextWindow: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  latencyMs: number;
  available: boolean;
}

export class ProviderRegistry {
  private readonly models = new Map<string, ProviderModel>();

  register(model: ProviderModel): void {
    if (this.models.has(model.id)) throw new Error(`Model already registered: ${model.id}`);
    this.models.set(model.id, { ...model, capabilities: [...new Set(model.capabilities)] });
  }

  list(filters: { capability?: string; provider?: string; availableOnly?: boolean } = {}): ProviderModel[] {
    return [...this.models.values()].filter((model) => (!filters.capability || model.capabilities.includes(filters.capability)) && (!filters.provider || model.provider === filters.provider) && (!filters.availableOnly || model.available)).map((model) => structuredClone(model));
  }

  select(capability: string, budgetUsd: number, maxLatencyMs: number): ProviderModel {
    const candidates = this.list({ capability, availableOnly: true }).filter((model) => model.latencyMs <= maxLatencyMs && model.inputCostPerMillion <= budgetUsd * 1_000_000);
    candidates.sort((left, right) => left.latencyMs - right.latencyMs || left.inputCostPerMillion - right.inputCostPerMillion);
    const selected = candidates[0];
    if (!selected) throw new Error(`No available model satisfies capability=${capability}`);
    return selected;
  }
}
