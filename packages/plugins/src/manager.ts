import type { AgentRegistry } from '../../agents/src/index.js';
import type { HookContext, HookDefinition, HookEngine, HookResult } from '../../hooks/src/index.js';
import type { ToolDefinition, ToolRegistry } from '../../tools/src/index.js';
import { PluginArtifactStore } from './artifacts.js';
import {
  type ManagedPluginManifest,
  type PluginHookContribution,
  type PluginInstallPolicy,
  type PluginSkill,
  type PluginToolContribution,
  type PluginTrustStore,
  verifyManagedManifest,
} from './manifest.js';
import {
  DurablePluginStore,
  type ManagedPluginArtifactRecord,
  type ManagedPluginRecord,
  type ManagedPluginRegistrations,
} from './store.js';

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

export interface PluginWorkerRuntime {
  start(pluginId: string, manifest: ManagedPluginManifest, artifact: ManagedPluginArtifactRecord): Promise<void>;
  callTool(pluginId: string, name: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  callHook(
    pluginId: string,
    name: string,
    event: string,
    context: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  stop(pluginId: string): Promise<void>;
}

export interface DurablePluginManagerOptions {
  store: DurablePluginStore;
  trust: PluginTrustStore;
  policy: PluginInstallPolicy;
  tools: ToolRegistry;
  hooks: HookEngine;
  agents: AgentRegistry;
  handlers?: PluginHandlerResolver;
  artifacts?: PluginArtifactStore;
  workers?: PluginWorkerRuntime;
}

export class DurablePluginManager {
  private readonly store: DurablePluginStore;
  private readonly trust: PluginTrustStore;
  private readonly policy: PluginInstallPolicy;
  private readonly tools: ToolRegistry;
  private readonly hooks: HookEngine;
  private readonly agents: AgentRegistry;
  private readonly handlers: PluginHandlerResolver;
  private readonly artifacts: PluginArtifactStore | undefined;
  private readonly workers: PluginWorkerRuntime | undefined;
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
    this.artifacts = options.artifacts;
    this.workers = options.workers;
    if (Boolean(this.artifacts) !== Boolean(this.workers)) {
      throw new Error('Durable plugin worker mode requires both artifacts and workers');
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    const durable = await this.store.list();
    this.records.clear();

    const restored: Array<{ pluginId: string; registrations: ManagedPluginRegistrations; workerStarted: boolean }> = [];
    try {
      for (const record of durable) {
        const verified = verifyManagedManifest(record.manifest, this.trust, this.policy);
        if (verified.manifestDigest !== record.manifestDigest) {
          throw new Error(`Plugin durable manifest digest mismatch: ${record.manifest.id}`);
        }

        const executable = hasExecutableContributions(verified.manifest);
        const artifact = await this.verifyDurableArtifact(record, verified.manifest);
        let registrations = emptyRegistrations();
        let workerStarted = false;
        if (record.status === 'enabled') {
          if (this.workers && executable) {
            await this.workers.start(record.manifest.id, verified.manifest, requireArtifact(record.manifest.id, artifact));
            workerStarted = true;
          }
          try {
            registrations = await this.registerContributions(verified.manifest);
          } catch (error) {
            if (workerStarted) await this.stopWorkerQuietly(record.manifest.id);
            throw error;
          }
          restored.push({ pluginId: record.manifest.id, registrations, workerStarted });
        }

        const next: ManagedPluginRecord = {
          ...record,
          manifest: verified.manifest,
          registrations,
          updatedAt: new Date().toISOString(),
          ...(artifact ? { artifact } : {}),
        };
        if (!artifact && 'artifact' in next) delete next.artifact;
        await this.store.put(next);
        this.records.set(record.manifest.id, cloneRecord(next));
      }
      this.initialized = true;
    } catch (error) {
      for (const item of restored.reverse()) {
        this.rollback(item.registrations);
        if (item.workerStarted) await this.stopWorkerQuietly(item.pluginId);
      }
      this.records.clear();
      throw error;
    }
  }

  async install(manifest: ManagedPluginManifest, artifactSourcePath?: string): Promise<ManagedPluginRecord> {
    this.assertInitialized();
    return this.serialize(async () => {
      if (this.records.has(manifest.id)) throw new Error(`Plugin already installed: ${manifest.id}`);
      const verified = verifyManagedManifest(manifest, this.trust, this.policy);
      const artifact = await this.installArtifact(verified.manifest, artifactSourcePath);
      const now = new Date().toISOString();
      const record: ManagedPluginRecord = {
        manifest: verified.manifest,
        manifestDigest: verified.manifestDigest,
        verifiedSignerKeyId: verified.manifest.signerKeyId,
        status: 'installed',
        installedAt: now,
        updatedAt: now,
        registrations: emptyRegistrations(),
        ...(artifact ? { artifact } : {}),
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
      const executable = hasExecutableContributions(verified.manifest);
      const artifact = await this.verifyDurableArtifact(current, verified.manifest);

      let registrations: ManagedPluginRegistrations | undefined;
      let workerStarted = false;
      try {
        if (this.workers && executable) {
          await this.workers.start(id, verified.manifest, requireArtifact(id, artifact));
          workerStarted = true;
        }
        registrations = await this.registerContributions(verified.manifest);
        const next: ManagedPluginRecord = {
          ...current,
          manifest: verified.manifest,
          status: 'enabled',
          updatedAt: new Date().toISOString(),
          registrations,
          ...(artifact ? { artifact } : {}),
        };
        if (!artifact && 'artifact' in next) delete next.artifact;
        const stored = await this.store.put(next);
        this.records.set(id, cloneRecord(stored));
        return cloneRecord(stored);
      } catch (error) {
        if (registrations) this.rollback(registrations);
        if (workerStarted) await this.stopWorkerQuietly(id);
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
      if (current.status === 'enabled') {
        this.rollback(current.registrations);
        if (this.workers && hasExecutableContributions(current.manifest)) await this.workers.stop(id);
      }
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
      if (current.status === 'enabled') {
        this.rollback(current.registrations);
        if (this.workers && hasExecutableContributions(current.manifest)) await this.workers.stop(id);
      }
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

  private async installArtifact(manifest: ManagedPluginManifest, artifactSourcePath: string | undefined): Promise<ManagedPluginArtifactRecord | undefined> {
    if (!hasExecutableContributions(manifest)) return undefined;
    if (!this.artifacts) {
      if (artifactSourcePath !== undefined) throw new Error('Plugin artifact source requires worker mode');
      return undefined;
    }
    if (!artifactSourcePath?.trim()) throw new Error(`Plugin artifact source is required: ${manifest.id}`);
    return this.artifacts.install(artifactSourcePath, manifest.artifactDigest);
  }

  private async verifyDurableArtifact(record: ManagedPluginRecord, manifest: ManagedPluginManifest): Promise<ManagedPluginArtifactRecord | undefined> {
    if (!hasExecutableContributions(manifest)) return undefined;
    if (!this.artifacts) return record.artifact ? { ...record.artifact } : undefined;
    const artifact = requireArtifact(manifest.id, record.artifact);
    return this.artifacts.verify(artifact, manifest.artifactDigest);
  }

  private async registerContributions(manifest: ManagedPluginManifest): Promise<ManagedPluginRegistrations> {
    const registrations = emptyRegistrations();
    try {
      for (const contribution of manifest.contributions?.tools ?? []) {
        const handler = await this.resolveToolHandler(manifest.id, contribution);
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
        const handler = await this.resolveHookHandler(manifest.id, contribution);
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

  private async resolveToolHandler(pluginId: string, contribution: PluginToolContribution): Promise<ToolDefinition['handler'] | undefined> {
    const trustedHandler = await this.handlers.tool?.(pluginId, structuredClone(contribution));
    if (trustedHandler) return trustedHandler;
    if (this.workers) {
      return async (input: Record<string, unknown>) => this.workers!.callTool(pluginId, contribution.name, structuredClone(input));
    }
    return undefined;
  }

  private async resolveHookHandler(pluginId: string, contribution: PluginHookContribution): Promise<HookDefinition['handler'] | undefined> {
    const trustedHandler = await this.handlers.hook?.(pluginId, structuredClone(contribution));
    if (trustedHandler) return trustedHandler;
    if (this.workers) {
      const hookId = namespaced(pluginId, 'hook', contribution.name);
      return async (context: HookContext): Promise<HookResult> => {
        const result = await this.workers!.callHook(
          pluginId,
          contribution.name,
          context.event,
          structuredClone(context) as unknown as Record<string, unknown>,
          contribution.timeoutMs,
        );
        return validateWorkerHookResult(result, hookId);
      };
    }
    return undefined;
  }

  private rollback(registrations: ManagedPluginRegistrations): void {
    for (const agentId of [...registrations.agents].reverse()) this.agents.remove(agentId);
    for (const hookId of [...registrations.hooks].reverse()) this.hooks.unregister(hookId);
    for (const toolName of [...registrations.tools].reverse()) this.tools.unregister(toolName);
  }

  private async stopWorkerQuietly(pluginId: string): Promise<void> {
    try {
      await this.workers?.stop(pluginId);
    } catch {
      // The enabling/restoring error remains authoritative; worker implementations
      // are required to fail closed and terminate their session on stop attempts.
    }
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

function hasExecutableContributions(manifest: ManagedPluginManifest): boolean {
  return (manifest.contributions?.tools?.length ?? 0) > 0 || (manifest.contributions?.hooks?.length ?? 0) > 0;
}

function namespaced(pluginId: string, kind: 'tool' | 'hook' | 'agent' | 'skill', name: string): string {
  return `plugin:${pluginId}:${kind}:${name}`;
}

function emptyRegistrations(): ManagedPluginRegistrations {
  return { tools: [], hooks: [], agents: [] };
}

function requireArtifact(pluginId: string, artifact: ManagedPluginArtifactRecord | undefined): ManagedPluginArtifactRecord {
  if (!artifact) throw new Error(`Plugin durable artifact is missing: ${pluginId}`);
  return { ...artifact };
}

function validateWorkerHookResult(value: unknown, expectedHookId: string): HookResult {
  if (!isRecord(value)) throw new Error(`Plugin worker hook result must be an object: ${expectedHookId}`);
  if (value.hookId !== expectedHookId) throw new Error(`Plugin worker hook returned mismatched hookId: ${expectedHookId}`);
  if (value.action !== 'continue' && value.action !== 'block') throw new Error(`Plugin worker hook action is invalid: ${expectedHookId}`);
  if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error(`Plugin worker hook reason is invalid: ${expectedHookId}`);
  if (value.annotations !== undefined && !isRecord(value.annotations)) throw new Error(`Plugin worker hook annotations are invalid: ${expectedHookId}`);
  if (value.evidence !== undefined && !isStringArray(value.evidence)) throw new Error(`Plugin worker hook evidence is invalid: ${expectedHookId}`);
  if (value.warnings !== undefined && !isStringArray(value.warnings)) throw new Error(`Plugin worker hook warnings are invalid: ${expectedHookId}`);
  return {
    hookId: expectedHookId,
    action: value.action,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(isRecord(value.annotations) ? { annotations: structuredClone(value.annotations) } : {}),
    ...(isStringArray(value.evidence) ? { evidence: [...value.evidence] } : {}),
    ...(isStringArray(value.warnings) ? { warnings: [...value.warnings] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function cloneRecord(record: ManagedPluginRecord): ManagedPluginRecord {
  return structuredClone(record);
}
