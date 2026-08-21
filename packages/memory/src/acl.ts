import type { MemoryAccessContext, MemoryAccessPolicy, MemoryEntry } from './types.js';
import { namespaceAllowed } from './namespace.js';

export function canReadMemory(entry: MemoryEntry, context: MemoryAccessContext): boolean {
  if (!namespaceAllowed(entry.namespace, context)) return false;
  const policy = entry.accessPolicy;
  if (policy.visibility === 'public') return true;
  if (policy.owner === context.subject || policy.allowedSubjects.includes('*') || policy.allowedSubjects.includes(context.subject)) return true;
  if (entry.agentId && context.agentId === entry.agentId) return true;
  if (entry.swarmId && context.swarmIds?.includes(entry.swarmId)) return policy.visibility === 'shared';
  return Boolean(context.canReadPrivate);
}

export function canDeleteMemory(entry: MemoryEntry, context: MemoryAccessContext): boolean {
  return Boolean(context.canDelete) || entry.accessPolicy.owner === context.subject;
}

export function assertMemoryWritePolicy(input: { namespace: MemoryEntry['namespace']; accessPolicy: MemoryAccessPolicy; subject: string }): void {
  if (!input.accessPolicy.owner) throw new Error('Memory access policy requires an owner');
  if (input.accessPolicy.owner !== input.subject && !input.accessPolicy.allowedSubjects.includes(input.subject) && !input.accessPolicy.allowedSubjects.includes('*')) throw new Error('Memory write is not authorized for this subject');
  if (input.namespace.startsWith('agent:') && input.namespace.slice(6) !== input.accessPolicy.owner && input.accessPolicy.visibility !== 'public') throw new Error('Private agent memory must be owned by the namespace agent');
}
