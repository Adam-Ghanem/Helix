export type ModelCapability =
  | 'chat'
  | 'reasoning'
  | 'tool-use'
  | 'vision'
  | 'structured-output'
  | 'streaming'
  | 'embeddings';

export interface ModelProfile {
  id: string;
  provider: string;
  model: string;
  capabilities: ModelCapability[];
  contextWindow: number;
  maxOutputTokens?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  latencyClass?: 'low' | 'medium' | 'high';
  enabled: boolean;
  metadata?: Record<string, string>;
}

export interface ModelDiscovery {
  provider: string;
  discoveredAt: string;
  models: ModelProfile[];
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelProfile>();

  register(profile: ModelProfile): ModelProfile {
    if (!profile.id || !profile.provider || !profile.model) throw new Error('Model id, provider, and model are required');
    if (profile.contextWindow <= 0) throw new Error('Model contextWindow must be positive');
    this.models.set(profile.id, { ...profile, capabilities: [...new Set(profile.capabilities)] });
    return this.models.get(profile.id)!;
  }

  registerMany(profiles: ModelProfile[]): void {
    for (const profile of profiles) this.register(profile);
  }

  get(id: string): ModelProfile {
    const profile = this.models.get(id);
    if (!profile) throw new Error(`Unknown model: ${id}`);
    return profile;
  }

  list(filter?: { provider?: string; capability?: ModelCapability; enabledOnly?: boolean }): ModelProfile[] {
    return [...this.models.values()].filter((profile) =>
      (!filter?.provider || profile.provider === filter.provider) &&
      (!filter?.capability || profile.capabilities.includes(filter.capability)) &&
      (!filter?.enabledOnly || profile.enabled),
    );
  }

  discover(discovery: ModelDiscovery): void {
    this.registerMany(discovery.models.map((model) => ({ ...model, provider: discovery.provider })));
  }

  disable(id: string): void {
    const profile = this.get(id);
    this.models.set(id, { ...profile, enabled: false });
  }

  enable(id: string): void {
    const profile = this.get(id);
    this.models.set(id, { ...profile, enabled: true });
  }
}
