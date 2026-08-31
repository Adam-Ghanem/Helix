import { createHash, createPublicKey, verify } from 'node:crypto';
import type { HookEventName } from '../../hooks/src/index.js';
import type { ToolSchema } from '../../tools/src/index.js';
import type { PluginManifest, PluginPermission, PluginPolicy } from './index.js';

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CONTRIBUTION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

export interface PluginToolContribution {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  permissions: string[];
  inputSchema: ToolSchema;
}

export interface PluginHookContribution {
  name: string;
  events: HookEventName[];
  priority: number;
  critical: boolean;
  timeoutMs: number;
  alwaysRun?: boolean;
}

export interface PluginAgentContribution {
  name: string;
  role: string;
  capabilities: string[];
  permissions?: string[];
  model?: string;
  provider?: string;
}

export interface PluginSkill {
  name: string;
  description: string;
  instructions: string;
  requiredTools?: string[];
  requiredCapabilities?: string[];
}

export interface PluginContributionSet {
  tools?: PluginToolContribution[];
  hooks?: PluginHookContribution[];
  agents?: PluginAgentContribution[];
  skills?: PluginSkill[];
}

export interface ManagedPluginManifest extends PluginManifest {
  id: string;
  apiVersion: string;
  artifactDigest: string;
  signerKeyId: string;
  signature: string;
  contributions?: PluginContributionSet;
}

export interface PluginTrustStore {
  keys: Record<string, string>;
}

export interface PluginInstallPolicy extends PluginPolicy {
  allowedApiVersions: string[];
  maxContributionsPerKind?: number;
}

export interface VerifiedManagedManifest {
  manifest: ManagedPluginManifest;
  manifestDigest: string;
}

export function managedPluginSigningPayload(manifest: ManagedPluginManifest): Buffer {
  const unsigned = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    permissions: canonicalSet(manifest.permissions),
    capabilities: canonicalSet(manifest.capabilities ?? []),
    tools: canonicalSet(manifest.tools ?? []),
    entrypoint: manifest.entrypoint,
    integrity: manifest.integrity ?? null,
    artifactDigest: manifest.artifactDigest,
    signerKeyId: manifest.signerKeyId,
    contributions: canonicalContributionSet(manifest.contributions),
  };
  return Buffer.from(stableJson(unsigned), 'utf8');
}

export function verifyManagedManifest(
  manifest: ManagedPluginManifest,
  trust: PluginTrustStore,
  policy: PluginInstallPolicy,
): VerifiedManagedManifest {
  validateManagedShape(manifest, policy);
  const trustedKey = trust.keys[manifest.signerKeyId];
  if (!trustedKey?.trim()) throw new Error(`Plugin signer is not trusted: ${manifest.signerKeyId}`);
  if (!manifest.signature.trim()) throw new Error('Plugin signature is required');

  let signature: Buffer;
  try {
    signature = Buffer.from(manifest.signature, 'base64');
  } catch {
    throw new Error('Plugin signature is not valid base64');
  }
  if (!signature.length) throw new Error('Plugin signature is required');

  let valid = false;
  try {
    valid = verify(null, managedPluginSigningPayload(manifest), createPublicKey(trustedKey), signature);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plugin signature verification failed: ${message}`);
  }
  if (!valid) throw new Error(`Plugin signature verification failed: ${manifest.id}`);

  const normalized = normalizeManagedManifest(manifest);
  const manifestDigest = createHash('sha256').update(managedPluginSigningPayload(normalized)).digest('hex');
  return { manifest: normalized, manifestDigest };
}

function validateManagedShape(manifest: ManagedPluginManifest, policy: PluginInstallPolicy): void {
  if (!PLUGIN_ID_PATTERN.test(manifest.id)) throw new Error('Invalid plugin id');
  if (!manifest.name.trim() || !manifest.version.trim() || !manifest.entrypoint.trim()) throw new Error('Plugin manifest is incomplete');
  if (!manifest.apiVersion.trim() || !policy.allowedApiVersions.includes(manifest.apiVersion)) throw new Error(`Plugin API version denied: ${manifest.apiVersion}`);
  if (!SHA256_PATTERN.test(manifest.artifactDigest)) throw new Error('Plugin artifactDigest must be a SHA-256 hex digest');
  if (!manifest.signerKeyId.trim()) throw new Error('Plugin signerKeyId is required');
  if (!Array.isArray(manifest.permissions)) throw new Error('Plugin permissions must be an array');

  for (const permission of manifest.permissions) {
    if (!policy.allowedPermissions.includes(permission)) throw new Error(`Plugin permission denied: ${permission}`);
  }
  if (policy.allowedCapabilities) {
    for (const capability of manifest.capabilities ?? []) {
      if (!policy.allowedCapabilities.includes(capability)) throw new Error(`Plugin capability denied: ${capability}`);
    }
  }

  const max = policy.maxContributionsPerKind ?? 64;
  if (!Number.isInteger(max) || max < 0) throw new Error('maxContributionsPerKind must be a non-negative integer');
  validateContributions(manifest.contributions, max, manifest.permissions);
}

function validateContributions(contributions: PluginContributionSet | undefined, max: number, permissions: PluginPermission[]): void {
  if (!contributions) return;
  const checks: Array<[keyof PluginContributionSet, PluginPermission]> = [
    ['tools', 'tool:register'],
    ['hooks', 'hook:register'],
    ['agents', 'agent:register'],
    ['skills', 'skill:register'],
  ];
  for (const [kind, requiredPermission] of checks) {
    const items = contributions[kind] ?? [];
    if (items.length > max) throw new Error(`Plugin contribution limit exceeded: ${String(kind)}`);
    if (items.length && !permissions.includes(requiredPermission)) throw new Error(`Plugin permission denied: ${requiredPermission}`);
    const seen = new Set<string>();
    for (const item of items) {
      if (!CONTRIBUTION_NAME_PATTERN.test(item.name)) throw new Error(`Invalid plugin contribution name: ${item.name}`);
      if (seen.has(item.name)) throw new Error(`Duplicate plugin contribution: ${String(kind)}:${item.name}`);
      seen.add(item.name);
    }
  }

  for (const tool of contributions.tools ?? []) {
    if (!tool.description.trim()) throw new Error(`Plugin tool description is required: ${tool.name}`);
    if (!['low', 'medium', 'high'].includes(tool.risk)) throw new Error(`Invalid plugin tool risk: ${tool.name}`);
    for (const permission of tool.permissions) {
      if (!permissions.includes(permission)) throw new Error(`Plugin tool permission denied: ${permission}`);
    }
  }
  for (const hook of contributions.hooks ?? []) {
    if (!hook.events.length) throw new Error(`Plugin hook must subscribe to an event: ${hook.name}`);
    if (!Number.isFinite(hook.priority)) throw new Error(`Plugin hook priority must be finite: ${hook.name}`);
    if (!Number.isFinite(hook.timeoutMs) || hook.timeoutMs <= 0) throw new Error(`Plugin hook timeout must be greater than zero: ${hook.name}`);
  }
  for (const agent of contributions.agents ?? []) {
    if (!agent.role.trim() || !agent.capabilities.length) throw new Error(`Plugin agent is incomplete: ${agent.name}`);
    for (const permission of agent.permissions ?? []) {
      if (!permissions.includes(permission)) throw new Error(`Plugin agent permission denied: ${permission}`);
    }
  }
  for (const skill of contributions.skills ?? []) {
    if (!skill.description.trim() || !skill.instructions.trim()) throw new Error(`Plugin skill is incomplete: ${skill.name}`);
  }
}

function normalizeManagedManifest(manifest: ManagedPluginManifest): ManagedPluginManifest {
  return {
    ...structuredClone(manifest),
    artifactDigest: manifest.artifactDigest.toLowerCase(),
    permissions: canonicalSet(manifest.permissions),
    ...(manifest.capabilities ? { capabilities: canonicalSet(manifest.capabilities) } : {}),
    ...(manifest.tools ? { tools: canonicalSet(manifest.tools) } : {}),
    ...(manifest.contributions ? { contributions: normalizeContributions(manifest.contributions) } : {}),
  };
}

function normalizeContributions(input: PluginContributionSet): PluginContributionSet {
  return {
    ...(input.tools ? { tools: input.tools.map((tool) => ({ ...structuredClone(tool), permissions: canonicalSet(tool.permissions) })) } : {}),
    ...(input.hooks ? { hooks: input.hooks.map((hook) => ({ ...structuredClone(hook), events: canonicalSet(hook.events) })) } : {}),
    ...(input.agents ? { agents: input.agents.map((agent) => ({ ...structuredClone(agent), capabilities: canonicalSet(agent.capabilities), ...(agent.permissions ? { permissions: canonicalSet(agent.permissions) } : {}) })) } : {}),
    ...(input.skills ? { skills: input.skills.map((skill) => ({ ...structuredClone(skill), ...(skill.requiredTools ? { requiredTools: canonicalSet(skill.requiredTools) } : {}), ...(skill.requiredCapabilities ? { requiredCapabilities: canonicalSet(skill.requiredCapabilities) } : {}) })) } : {}),
  };
}

function canonicalContributionSet(input: PluginContributionSet | undefined): unknown {
  if (!input) return null;
  return {
    tools: (input.tools ?? []).map((tool) => ({ ...tool, permissions: canonicalSet(tool.permissions) })),
    hooks: (input.hooks ?? []).map((hook) => ({ ...hook, events: canonicalSet(hook.events) })),
    agents: (input.agents ?? []).map((agent) => ({ ...agent, capabilities: canonicalSet(agent.capabilities), permissions: canonicalSet(agent.permissions ?? []) })),
    skills: (input.skills ?? []).map((skill) => ({ ...skill, requiredTools: canonicalSet(skill.requiredTools ?? []), requiredCapabilities: canonicalSet(skill.requiredCapabilities ?? []) })),
  };
}

function canonicalSet<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}