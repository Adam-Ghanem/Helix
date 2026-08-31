import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedPluginManifest } from './manifest.js';

const STORE_SCHEMA_VERSION = 1 as const;

export type ManagedPluginStatus = 'installed' | 'enabled' | 'disabled';

export interface ManagedPluginRegistrations {
  tools: string[];
  hooks: string[];
  agents: string[];
}

export interface ManagedPluginRecord {
  manifest: ManagedPluginManifest;
  manifestDigest: string;
  verifiedSignerKeyId: string;
  status: ManagedPluginStatus;
  installedAt: string;
  updatedAt: string;
  registrations: ManagedPluginRegistrations;
}

interface PluginStoreDocument {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  plugins: ManagedPluginRecord[];
}

export interface DurablePluginStoreOptions {
  directory: string;
  filename?: string;
}

export class DurablePluginStore {
  private readonly directory: string;
  private readonly path: string;
  private readonly records = new Map<string, ManagedPluginRecord>();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: DurablePluginStoreOptions) {
    if (!options.directory.trim()) throw new Error('Plugin store directory is required');
    this.directory = options.directory;
    this.path = join(options.directory, options.filename ?? 'plugins.json');
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const document = validateDocument(parsed);
      this.records.clear();
      for (const record of document.plugins) {
        if (this.records.has(record.manifest.id)) throw new Error(`Duplicate plugin in durable state: ${record.manifest.id}`);
        this.records.set(record.manifest.id, cloneRecord(record));
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.records.clear();
    }
    this.initialized = true;
  }

  async put(record: ManagedPluginRecord): Promise<ManagedPluginRecord> {
    this.assertInitialized();
    validateRecord(record);
    return this.serialize(async () => {
      this.records.set(record.manifest.id, cloneRecord(record));
      await this.persist();
      return cloneRecord(record);
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

  async remove(id: string): Promise<boolean> {
    this.assertInitialized();
    return this.serialize(async () => {
      const removed = this.records.delete(id);
      if (removed) await this.persist();
      return removed;
    });
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('DurablePluginStore.init() must be called before use');
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    const document: PluginStoreDocument = {
      schemaVersion: STORE_SCHEMA_VERSION,
      plugins: [...this.records.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)).map(cloneRecord),
    };
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function validateDocument(value: unknown): PluginStoreDocument {
  if (!isRecord(value) || value.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(value.plugins)) {
    throw new Error('Invalid durable plugin store document');
  }
  const plugins = value.plugins.map((item) => validateRecord(item));
  return { schemaVersion: STORE_SCHEMA_VERSION, plugins };
}

function validateRecord(value: unknown): ManagedPluginRecord {
  if (!isRecord(value) || !isRecord(value.manifest)) throw new Error('Invalid durable plugin record');
  const manifest = value.manifest as unknown as ManagedPluginManifest;
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) throw new Error('Invalid durable plugin id');
  if (typeof value.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestDigest)) throw new Error(`Invalid durable manifest digest: ${manifest.id}`);
  if (typeof value.verifiedSignerKeyId !== 'string' || !value.verifiedSignerKeyId.trim()) throw new Error(`Invalid durable signer: ${manifest.id}`);
  if (value.status !== 'installed' && value.status !== 'enabled' && value.status !== 'disabled') throw new Error(`Invalid durable plugin status: ${manifest.id}`);
  if (typeof value.installedAt !== 'string' || !Number.isFinite(Date.parse(value.installedAt))) throw new Error(`Invalid durable installedAt: ${manifest.id}`);
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error(`Invalid durable updatedAt: ${manifest.id}`);
  if (!isRecord(value.registrations) || !isStringArray(value.registrations.tools) || !isStringArray(value.registrations.hooks) || !isStringArray(value.registrations.agents)) {
    throw new Error(`Invalid durable plugin registrations: ${manifest.id}`);
  }
  return cloneRecord(value as unknown as ManagedPluginRecord);
}

function cloneRecord(record: ManagedPluginRecord): ManagedPluginRecord {
  return {
    ...structuredClone(record),
    registrations: {
      tools: [...record.registrations.tools],
      hooks: [...record.registrations.hooks],
      agents: [...record.registrations.agents],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
