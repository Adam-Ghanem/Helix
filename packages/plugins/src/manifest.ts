import { createHash, createPublicKey, verify } from 'node:crypto';
import type { HookEventName } from '../../hooks/src/index.js';
import type { JsonType, ToolSchema } from '../../tools/src/index.js';
import type { PluginManifest, PluginPermission, PluginPolicy } from './index.js';

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CONTRIBUTION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const HOOK_EVENTS = new Set<HookEventName>(['session-start', 'session-end', 'pre-task', 'post-task', 'pre-edit', 'post-edit', 'pre-command', 'post-command', 'pre-tool', 'post-tool', 'on-failure', 'pre-review', 'post-review']);
const JSON_TYPES = new Set<JsonType>(['string', 'number', 'boolean', 'object', 'array']);

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

  const signature = Buffer.from(manifest.signature, 'base64');
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
  const raw = manifest as unknown;
  if (!isRecord(raw)) throw new Error('Plugin manifest must be a JSON object');

  const pluginId = requireNonEmptyString(raw.id, 'id');
  if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new Error('Invalid plugin id');
  requireNonEmptyString(raw.name, 'name');
  requireNonEmptyString(raw.version, 'version');
  const apiVersion = requireNonEmptyString(raw.apiVersion, 'apiVersion');
  requireNonEmptyString(raw.entrypoint, 'entrypoint');
  const artifactDigest = requireNonEmptyString(raw.artifactDigest, 'artifactDigest');
  requireNonEmptyString(raw.signerKeyId, 'signerKeyId');
  requireNonEmptyString(raw.signature, 'signature');

  if (!policy.allowedApiVersions.includes(apiVersion)) throw new Error(`Plugin API version denied: ${apiVersion}`);
  if (!SHA256_PATTERN.test(artifactDigest)) throw new Error('Plugin artifactDigest must be a SHA-256 hex digest');
  if (raw.integrity !== undefined && typeof raw.integrity !== 'string') throw new Error('Plugin manifest integrity must be a string');

  const permissions = requireStringArray(raw.permissions, 'permissions');
  const capabilities = optionalStringArray(raw.capabilities, 'capabilities');
  optionalStringArray(raw.tools, 'tools');
  for (const permission of permissions) {
    if (!policy.allowedPermissions.includes(permission)) throw new Error(`Plugin permission denied: ${permission}`);
  }
  if (policy.allowedCapabilities) {
    for (const capability of capabilities) {
      if (!policy.allowedCapabilities.includes(capability)) throw new Error(`Plugin capability denied: ${capability}`);
    }
  }

  const max = policy.maxContributionsPerKind ?? 64;
  if (!Number.isInteger(max) || max < 0) throw new Error('maxContributionsPerKind must be a non-negative integer');
  validateContributions(raw.contributions, max, permissions);
}

function validateContributions(value: unknown, max: number, permissions: PluginPermission[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error('Plugin contributions must be an object');
  const contributionPermissions: Record<keyof PluginContributionSet, PluginPermission> = {
    tools: 'tool:register',
    hooks: 'hook:register',
    agents: 'agent:register',
    skills: 'skill:register',
  };

  for (const kind of Object.keys(contributionPermissions) as Array<keyof PluginContributionSet>) {
    const rawItems = value[kind];
    if (rawItems === undefined) continue;
    if (!Array.isArray(rawItems)) throw new Error(`Plugin contributions ${kind} must be an array`);
    if (rawItems.length > max) throw new Error(`Plugin contribution limit exceeded: ${kind}`);
    if (rawItems.length && !permissions.includes(contributionPermissions[kind])) throw new Error(`Plugin permission denied: ${contributionPermissions[kind]}`);
    const seen = new Set<string>();
    for (const rawItem of rawItems) {
      if (!isRecord(rawItem)) throw new Error(`Plugin contribution ${kind} entry must be an object`);
      const name = requireNonEmptyString(rawItem.name, `${kind}.name`);
      if (!CONTRIBUTION_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin contribution name: ${name}`);
      if (seen.has(name)) throw new Error(`Duplicate plugin contribution: ${kind}:${name}`);
      seen.add(name);
    }
  }

  for (const rawTool of optionalRecordArray(value.tools, 'tools')) validateTool(rawTool, permissions);
  for (const rawHook of optionalRecordArray(value.hooks, 'hooks')) validateHook(rawHook);
  for (const rawAgent of optionalRecordArray(value.agents, 'agents')) validateAgent(rawAgent, permissions);
  for (const rawSkill of optionalRecordArray(value.skills, 'skills')) validateSkill(rawSkill);
}

function validateTool(tool: Record<string, unknown>, permissions: PluginPermission[]): void {
  const name = requireNonEmptyString(tool.name, 'tools.name');
  requireNonEmptyString(tool.description, `tool ${name} description`);
  if (tool.risk !== 'low' && tool.risk !== 'medium' && tool.risk !== 'high') throw new Error(`Invalid plugin tool risk: ${name}`);
  const toolPermissions = requireStringArray(tool.permissions, `tool ${name} permissions`);
  for (const permission of toolPermissions) {
    if (!permissions.includes(permission)) throw new Error(`Plugin tool permission denied: ${permission}`);
  }
  validateToolSchema(tool.inputSchema, name);
}

function validateToolSchema(value: unknown, toolName: string): void {
  if (!isRecord(value)) throw new Error(`Plugin tool inputSchema must be an object: ${toolName}`);
  if (value.required !== undefined) requireStringArray(value.required, `tool ${toolName} inputSchema.required`);
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) throw new Error(`Plugin tool inputSchema.properties must be an object: ${toolName}`);
    for (const [field, type] of Object.entries(value.properties)) {
      if (typeof type !== 'string' || !JSON_TYPES.has(type as JsonType)) throw new Error(`Invalid plugin tool schema type for ${toolName}.${field}`);
    }
  }
}

function validateHook(hook: Record<string, unknown>): void {
  const name = requireNonEmptyString(hook.name, 'hooks.name');
  const events = requireStringArray(hook.events, `hook ${name} events`);
  if (!events.length) throw new Error(`Plugin hook must subscribe to an event: ${name}`);
  for (const event of events) if (!HOOK_EVENTS.has(event as HookEventName)) throw new Error(`Invalid plugin hook event: ${event}`);
  if (typeof hook.priority !== 'number' || !Number.isFinite(hook.priority)) throw new Error(`Plugin hook priority must be finite: ${name}`);
  if (typeof hook.critical !== 'boolean') throw new Error(`Plugin hook critical must be boolean: ${name}`);
  if (typeof hook.timeoutMs !== 'number' || !Number.isFinite(hook.timeoutMs) || hook.timeoutMs <= 0) throw new Error(`Plugin hook timeout must be greater than zero: ${name}`);
  if (hook.alwaysRun !== undefined && typeof hook.alwaysRun !== 'boolean') throw new Error(`Plugin hook alwaysRun must be boolean: ${name}`);
}

function validateAgent(agent: Record<string, unknown>, permissions: PluginPermission[]): void {
  const name = requireNonEmptyString(agent.name, 'agents.name');
  requireNonEmptyString(agent.role, `agent ${name} role`);
  const capabilities = requireStringArray(agent.capabilities, `agent ${name} capabilities`);
  if (!capabilities.length) throw new Error(`Plugin agent capabilities are required: ${name}`);
  const agentPermissions = optionalStringArray(agent.permissions, `agent ${name} permissions`);
  for (const permission of agentPermissions) {
    if (!permissions.includes(permission)) throw new Error(`Plugin agent permission denied: ${permission}`);
  }
  if (agent.model !== undefined && (typeof agent.model !== 'string' || !agent.model.trim())) throw new Error(`Plugin agent model must be a non-empty string: ${name}`);
  if (agent.provider !== undefined && (typeof agent.provider !== 'string' || !agent.provider.trim())) throw new Error(`Plugin agent provider must be a non-empty string: ${name}`);
}

function validateSkill(skill: Record<string, unknown>): void {
  const name = requireNonEmptyString(skill.name, 'skills.name');
  requireNonEmptyString(skill.description, `skill ${name} description`);
  requireNonEmptyString(skill.instructions, `skill ${name} instructions`);
  optionalStringArray(skill.requiredTools, `skill ${name} requiredTools`);
  optionalStringArray(skill.requiredCapabilities, `skill ${name} requiredCapabilities`);
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

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Plugin manifest ${field} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error(`Plugin manifest ${field} must be a string array`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  return requireStringArray(value, field);
}

function optionalRecordArray(value: unknown, field: string): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`Plugin contributions ${field} must be an array of objects`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
