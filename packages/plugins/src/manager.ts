import type { AgentRegistry } from '../../agents/src/index.js';
import type { HookDefinition, HookEngine } from '../../hooks/src/index.js';
import type { ToolDefinition, ToolRegistry } from '../../tools/src/index.js';
import {
  type ManagedPluginManifest,
  type PluginHookContribution,
  type PluginInstallPolicy,
  type PluginSkill,
  type PluginToolContribution,
  type PluginTrustStore,
  verifyManagedManifest,
} from './manifest.js';
import { DurablePluginStore, type ManagedPluginRecord, type ManagedPluginRegistrations } from './store.js';

export interface ResolvedPluginSkill extends PluginSkill {
  id: string;
  pluginId: string;
}

export interface PluginHandlerResolver {
  tool?: (
    pluginId: string,
    contribution: PluginToolContribution,
  ) => Promise<ToolDefinition['handler'] | undefined> | ToolDefinition['handler'] | undefined;
  hook?: (
    pluginId: string,
    contribution: PluginHookContribution,
  ) => Promise<HookDefinition['handler'] | undefined> | HookDefinition['handler'] | undefined;
}

export interface DurablePluginManagerOptions {
  store: DurablePluginStore;
  trust: PluginTrustStore;
  policy: PluginInstallPolicy;
  tools: ToolRegistry;
  hooks: HookEngine;
  agents: AgentRegistry;
  handlers?: PluginHandlerResolver;
}

export class DurablePluginManager {
  private readonly store: DurablePluginStore;
  private readonly trust: PluginTrustStore;
  private readonly policy: PluginInstallPolicy;
  private readonly tools: ToolRegistry;
  private readonly hooks: HookEngine;
  private readonly agents: AgentRegistry;
  private readonly handlers: PluginHandlerResolver;
  private readonly records = new Map<string, ManagedPluginRecord>();
  private initialized = false;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: DurablePluginManagerOptions) {
    this.store = options.store;
    this.trust = structuredClone(options.trust);
    this.policy = structuredClone(options.policy);
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.agents = options.agents;
    this.handlers = options.handlers ?? {};
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    const durable = await this.store.list();
    this.records.clear();

    const restored: Array<{ pluginId: string; registrations: ManagedPluginRegistrations }> = [];
    try {
      for (const record of durable) {
        const verified = verifyManagedManifest(record.manifest, this.trust, this.policy);
        if (verified.manifestDigest !== record.manifestDigest) {
          throw new Error(`Plugin durable manifest digest mismatch: ${record.manifest.id}`);
        }

        let registrations = emptyRegistrations();
        if (record.status === 'enabled') {
          registrations = await this.registerContributions(verified.manifest);
          restored.push({ pluginId: record.manifest.id, registrations });
        }

        const next: ManagedPluginRecord = {
          ...record,
          manifest: verified.manifest,
          registrations,
          updatedAt: new Date().toISOString(),
        };
        await this.store.put(next);
        this.records.set(record.manifest.id, cloneRecord(next));
      }
      this.initialized = true;
    } catch (error) {
      for (const item of restored.reverse()) this.rollback(item.registrations);
      this.records.clear();
      throw error;
    }
  }

  async install(manifest: ManagedPluginManifest): Promise<ManagedPluginRecord> {
    this.assertInitialized();
    return this.serialize(async () => {
      if (this.records.has(manifest.id)) throw new Error(`Plugin already installed: ${manifest.id}`);
      const verified = verifyManagedManifest(manifest, this.trust, this.policy);
      const now = new Date().toISOString();
      const record: ManagedPluginRecord = {
        manifest: verified.manifest,
        manifestDigest: verified.manifestDigest,
        verifiedSignerKeyId: verified.manifest.signerKeyId,
        status: 'installed',
        installedAt: now,
        updatedAt: now,
        registrations: emptyRegistrations(),
      };
      const stored = await this.store.put(record);
      this.records.set(stored.manifest.id, cloneRecord(stored));
      return cloneRecord(stored);
    });
  }

  async enable(id: string): Promise<ManagedPluginRecord> {
    this.assertInitialized();
    return this.serialize(async () => {
      const current = this.requireRecord(id);
      if (current.status === 'enabled') return cloneRecord(current);

      const verified = verifyManagedManifest(current.manifest, this.trust, this.policy);
      if (verified.manifestDigest !== current.manifestDigest) throw new Error(`Plugin durable manifest digest mismatch: ${id}`);

      let registrations: ManagedPluginRegistrations | undefined;
      try {
        registrations = await this.registerContributions(verified.manifest);
        const next: ManagedPluginRecord = {
          ...current,
          manifest: verified.manifest,
          status: 'enabled',
          updatedAt: new Date().toISOString(),
          registrations,
        };
        const stored = await this.store.put(next);
        this.records.set(id, cloneRecord(stored));
        return cloneRecord(stored);
      } catch (error) {
        if (registrations) this.rollback(registrations);
        throw error;
      }
    });
  }

  async disable(id: string): Promise<ManagedPluginRecord> {
    this.assertInitialized();
    return this.serialize(async () => {
      const current = this.requireRecord(id);
      if (current.status === 'disabled') return cloneRecord(current);

      const next: ManagedPluginRecord = {
        ...current,
        status: 'disabled',
        updatedAt: new Date().toISOString(),
        registrations: emptyRegistrations(),
      };
      const stored = await this.store.put(next);
      if (current.status === 'enabled') this.rollback(current.registrations);
      this.records.set(id, cloneRecord(stored));
      return cloneRecord(stored);
    });
  }

  async uninstall(id: string): Promise<void> {
    this.assertInitialized();
    await this.serialize(async () => {
      const current = this.requireRecord(id);
      const removed = await this.store.remove(id);
      if (!removed) throw new Error(`Unknown plugin: ${id}`);
      if (current.status === 'enabled') this.rollback(current.registrations);
      this.records.delete(id);
    });
  }

  async get(id: string): Promise<ManagedPluginRecord | undefined> {
    this.assertInitialized();
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async list(): Promise<ManagedPluginRecord[]> {
    this.assertInitialized();
    return [...this.records.values()]
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map(cloneRecord);
  }

  resolveSkill(pluginId: string, skillName: string): ResolvedPluginSkill {
    this.assertInitialized();
    const record = this.requireRecord(pluginId);
    if (record.status !== 'enabled') throw new Error(`Plugin is not enabled: ${pluginId}`);
    const skill = record.manifest.contributions?.skills?.find((candidate) => candidate.name === skillName);
    if (!skill) throw new Error(`Unknown plugin skill: ${pluginId}:${skillName}`);

    const localTools = new Set(record.manifest.contributions?.tools?.map((tool) => tool.name) ?? []);
    return {
      ...structuredClone(skill),
      id: namespaced(pluginId, 'skill', skill.name),
      pluginId,
      ...(skill.requiredTools ? {
        requiredTools: skill.requiredTools.map((tool) => localTools.has(tool) ? namespaced(pluginId, 'tool', tool) : tool),
      } : {}),
    };
  }

  private async registerContributions(manifest: ManagedPluginManifest): Promise<ManagedPluginRegistrations> {
    const registrations = emptyRegistrations();
    try {
      for (const contribution of manifest.contributions?.tools ?? []) {
        const handler = await this.handlers.tool?.(manifest.id, structuredClone(contribution));
        if (!handler) throw new Error(`Plugin tool handler unavailable: ${manifest.id}:${contribution.name}`);
        const name = namespaced(manifest.id, 'tool', contribution.name);
        this.tools.register({
          name,
          description: contribution.description,
          risk: contribution.risk,
          permissions: [...contribution.permissions],
          inputSchema: structuredClone(contribution.inputSchema),
          source: 'plugin',
          handler,
        });
        registrations.tools.push(name);
      }

      for (const contribution of manifest.contributions?.hooks ?? []) {
        const handler = await this.handlers.hook?.(manifest.id, structuredClone(contribution));
        if (!handler) throw new Error(`Plugin hook handler unavailable: ${manifest.id}:${contribution.name}`);
        const id = namespaced(manifest.id, 'hook', contribution.name);
        this.hooks.register({
          id,
          events: [...contribution.events],
          priority: contribution.priority,
          critical: contribution.critical,
          timeoutMs: contribution.timeoutMs,
          ...(contribution.alwaysRun !== undefined ? { alwaysRun: contribution.alwaysRun } : {}),
          handler,
        });
        registrations.hooks.push(id);
      }

      for (const contribution of manifest.contributions?.agents ?? []) {
        const profile = this.agents.register({
          name: namespaced(manifest.id, 'agent', contribution.name),
          role: contribution.role,
          capabilities: [...contribution.capabilities],
          ...(contribution.permissions ? { permissions: [...contribution.permissions] } : {}),
          ...(contribution.model ? { model: contribution.model } : {}),
          ...(contribution.provider ? { provider: contribution.provider } : {}),
        });
        registrations.agents.push(profile.id);
      }

      return registrations;
    } catch (error) {
      this.rollback(registrations);
      throw error;
    }
  }

  private rollback(registrations: ManagedPluginRegistrations): void {
    for (const agentId of [...registrations.agents].reverse()) this.agents.remove(agentId);
    for (const hookId of [...registrations.hooks].reverse()) this.hooks.unregister(hookId);
    for (const toolName of [...registrations.tools].reverse()) this.tools.unregister(toolName);
  }

  private requireRecord(id: string): ManagedPluginRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown plugin: ${id}`);
    return record;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('DurablePluginManager.init() must be called before use');
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation);
    this.operationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function namespaced(pluginId: string, kind: 'tool' | 'hook' | 'agent' | 'skill', name: string): string {
  return `plugin:${pluginId}:${kind}:${name}`;
}

function emptyRegistrations(): ManagedPluginRegistrations {
  return { tools: [], hooks: [], agents: [] };
}

function cloneRecord(record: ManagedPluginRecord): ManagedPluginRecord {
  return structuredClone(record);
}
