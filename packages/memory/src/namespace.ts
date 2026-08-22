import type { MemoryAccessContext, MemoryNamespace } from './types.js';

export function parseNamespace(value: string): MemoryNamespace {
  if (value === 'global' || /^agent:[^:]+$/.test(value) || /^swarm:[^:]+$/.test(value) || /^task:[^:]+$/.test(value) || /^session:[^:]+$/.test(value)) return value as MemoryNamespace;
  throw new Error(`Invalid memory namespace: ${value}`);
}

export function namespaceOwner(namespace: MemoryNamespace): string | undefined {
  if (namespace === 'global') return undefined;
  return namespace.slice(namespace.indexOf(':') + 1);
}

export function namespaceAllowed(namespace: MemoryNamespace, context: MemoryAccessContext): boolean {
  if (namespace === 'global') return true;
  const [kind, value] = namespace.split(':', 2);
  if (kind === 'agent') return context.agentId === value || context.subject === value || Boolean(context.canReadPrivate);
  if (kind === 'swarm') return context.swarmIds?.includes(value ?? '') === true || Boolean(context.canReadPrivate);
  if (kind === 'task') return context.taskIds?.includes(value ?? '') === true || Boolean(context.canReadPrivate);
  if (kind === 'session') return context.subject === value || Boolean(context.canReadPrivate);
  return false;
}

export function namespaceRelevance(namespace: MemoryNamespace, context?: MemoryAccessContext): number {
  if (!context) return namespace === 'global' ? 1 : 0.5;
  if (namespace === 'global') return 1;
  if (namespace === `agent:${context.agentId ?? context.subject}`) return 1;
  if (namespace.startsWith('swarm:') && context.swarmIds?.includes(namespace.slice(6))) return 0.95;
  if (namespace.startsWith('task:') && context.taskIds?.includes(namespace.slice(5))) return 0.9;
  if (namespace === `session:${context.subject}`) return 0.85;
  return 0.35;
}
