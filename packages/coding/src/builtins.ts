import { AgentRegistry } from '../../agents/src/index.js';
import { HookDefinition } from '../../hooks/src/index.js';
import { MemoryStore } from '../../memory/src/index.js';
import { validatePath } from '../../security/src/index.js';

export function createTaskPreparationHook(options: { memory?: MemoryStore; agents?: AgentRegistry }): HookDefinition {
  return {
    id: 'coding.task-preparation', events: ['pre-task'], priority: 20, critical: false, timeoutMs: 2_000,
    handler: async (context) => {
      const annotations: Record<string, unknown> = {};
      const warnings: string[] = [];
      const requiredCapabilities = Array.isArray((context.payload as Record<string, unknown>).requiredCapabilities)
        ? ((context.payload as Record<string, unknown>).requiredCapabilities as unknown[]).filter((value): value is string => typeof value === 'string') : ['coding'];
      if (options.agents) annotations.recommendedAgents = options.agents.findByCapabilities(requiredCapabilities).slice(0, 8).map((agent) => ({ id: agent.id, name: agent.name, capabilities: agent.capabilities }));
      if (options.memory) {
        try {
          const hits = await options.memory.search({ query: String((context.payload as Record<string, unknown>).goal ?? ''), namespace: 'coding', subject: 'coding-harness', limit: 5 });
          annotations.memory = hits.map((hit) => ({ content: hit.record.content, score: hit.score }));
        } catch (error) { warnings.push(`memory recall unavailable: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return { hookId: 'coding.task-preparation', action: 'continue', annotations, ...(warnings.length ? { warnings } : {}) };
    },
  };
}

export function createEditContextHook(options: { workspaceRoots: string[]; memory?: MemoryStore }): HookDefinition {
  return {
    id: 'coding.edit-context', events: ['pre-edit'], priority: 10, critical: true, timeoutMs: 2_000,
    handler: async (context) => {
      const path = (context.payload as Record<string, unknown>).path;
      if (typeof path !== 'string' || !path.trim()) return { hookId: 'coding.edit-context', action: 'block', reason: 'Edit path is required' };
      let resolved: string;
      try { resolved = validatePath(path, options.workspaceRoots); } catch (error) { return { hookId: 'coding.edit-context', action: 'block', reason: error instanceof Error ? error.message : String(error) }; }
      const annotations: Record<string, unknown> = { resolvedPath: resolved };
      if (options.memory) {
        try {
          const hits = await options.memory.search({ query: `${resolved} ${String((context.payload as Record<string, unknown>).goal ?? '')}`, namespace: 'coding', subject: 'coding-harness', limit: 5 });
          annotations.memory = hits.map((hit) => ({ content: hit.record.content, score: hit.score }));
        } catch { /* optional enrichment */ }
      }
      return { hookId: 'coding.edit-context', action: 'continue', annotations };
    },
  };
}

export function createCommandSafetyHook(options: { deniedPatterns?: RegExp[]; authorize?: (command: string, cwd: string) => Promise<{ allowed: boolean; reason: string }> }): HookDefinition {
  return {
    id: 'coding.command-safety', events: ['pre-command'], priority: 1, critical: true, timeoutMs: 2_000,
    handler: async (context) => {
      const command = (context.payload as Record<string, unknown>).command;
      if (typeof command !== 'string' || !command.trim()) return { hookId: 'coding.command-safety', action: 'block', reason: 'Command is required' };
      const denied = (options.deniedPatterns ?? []).find((pattern) => { pattern.lastIndex = 0; return pattern.test(command); });
      if (denied) return { hookId: 'coding.command-safety', action: 'block', reason: `Command matches denied pattern: ${denied}` };
      if (options.authorize) {
        const decision = await options.authorize(command, context.cwd);
        if (!decision.allowed) return { hookId: 'coding.command-safety', action: 'block', reason: decision.reason };
        return { hookId: 'coding.command-safety', action: 'continue', annotations: { authorizationReason: decision.reason } };
      }
      return { hookId: 'coding.command-safety', action: 'continue' };
    },
  };
}

export function createOutcomeLearningHook(options: { record: (input: { event: string; sessionId: string; payload: unknown }) => Promise<void> }): HookDefinition {
  return {
    id: 'coding.outcome-learning', events: ['post-task', 'post-edit', 'post-command', 'on-failure'], priority: 200, critical: false, timeoutMs: 2_000, alwaysRun: true,
    handler: async (context) => {
      await options.record({ event: context.event, sessionId: context.sessionId, payload: context.payload });
      return { hookId: 'coding.outcome-learning', action: 'continue' };
    },
  };
}

export function createQualityGateHook(): HookDefinition {
  return {
    id: 'coding.quality-gate', events: ['pre-review', 'post-review'], priority: 5, critical: true, timeoutMs: 1_000,
    handler: async (context) => {
      if (context.event === 'pre-review') return { hookId: 'coding.quality-gate', action: 'continue' };
      const payload = context.payload as Record<string, unknown>;
      const evidenceTypes = Array.isArray(payload.evidenceTypes) ? payload.evidenceTypes.filter((value): value is string => typeof value === 'string') : [];
      for (const required of ['review', 'test', 'judge']) if (!evidenceTypes.includes(required)) return { hookId: 'coding.quality-gate', action: 'block', reason: `Missing required ${required} evidence` };
      return { hookId: 'coding.quality-gate', action: 'continue' };
    },
  };
}
