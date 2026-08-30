export type HookEventName =
  | 'session-start'
  | 'session-end'
  | 'pre-task'
  | 'post-task'
  | 'pre-edit'
  | 'post-edit'
  | 'pre-command'
  | 'post-command'
  | 'pre-tool'
  | 'post-tool'
  | 'on-failure'
  | 'pre-review'
  | 'post-review';

export interface HookContext<T = Record<string, unknown>> {
  event: HookEventName;
  sessionId: string;
  executionId?: string;
  taskId?: string;
  agentId?: string;
  cwd: string;
  timestamp: string;
  payload: T;
  metadata: Record<string, unknown>;
}

export interface HookResult {
  hookId: string;
  action: 'continue' | 'block';
  reason?: string;
  annotations?: Record<string, unknown>;
  evidence?: string[];
  warnings?: string[];
}

export interface HookDefinition {
  id: string;
  events: HookEventName[];
  priority: number;
  critical: boolean;
  timeoutMs: number;
  alwaysRun?: boolean;
  matcher?: (context: HookContext) => boolean;
  handler: (context: HookContext) => Promise<HookResult>;
}

export interface HookExecutionRecord {
  hookId: string;
  action: 'continue' | 'block';
  reason?: string;
  warnings: string[];
  evidence: string[];
  annotations: Record<string, unknown>;
}

export interface HookRunResult {
  event: HookEventName;
  action: 'continue' | 'block';
  reason?: string;
  annotations: Record<string, unknown>;
  evidence: string[];
  warnings: string[];
  executions: HookExecutionRecord[];
}

interface RegisteredHook {
  definition: HookDefinition;
  order: number;
}

export class HookEngine {
  private readonly hooks = new Map<string, RegisteredHook>();
  private registrationOrder = 0;

  register(definition: HookDefinition): void {
    if (!definition.id.trim()) throw new Error('Hook id is required');
    if (this.hooks.has(definition.id)) throw new Error(`Hook already registered: ${definition.id}`);
    if (!definition.events.length) throw new Error('Hook must subscribe to at least one event');
    if (!Number.isFinite(definition.priority)) throw new Error('Hook priority must be finite');
    if (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0) throw new Error('Hook timeoutMs must be greater than zero');
    this.hooks.set(definition.id, { definition, order: this.registrationOrder++ });
  }

  unregister(hookId: string): boolean {
    return this.hooks.delete(hookId);
  }

  list(): HookDefinition[] {
    return [...this.hooks.values()]
      .sort((left, right) => left.definition.priority - right.definition.priority || left.order - right.order)
      .map(({ definition }) => ({ ...definition, events: [...definition.events] }));
  }

  async run(context: HookContext): Promise<HookRunResult> {
    const matching = [...this.hooks.values()]
      .filter(({ definition }) => definition.events.includes(context.event) && (!definition.matcher || definition.matcher(context)))
      .sort((left, right) => left.definition.priority - right.definition.priority || left.order - right.order);

    let action: 'continue' | 'block' = 'continue';
    let reason: string | undefined;
    const annotations: Record<string, unknown> = {};
    const evidence: string[] = [];
    const warnings: string[] = [];
    const executions: HookExecutionRecord[] = [];

    for (const { definition } of matching) {
      if (action === 'block' && !definition.alwaysRun) continue;
      const result = await this.execute(definition, context);
      Object.assign(annotations, result.annotations ?? {});
      evidence.push(...(result.evidence ?? []));
      warnings.push(...(result.warnings ?? []));
      executions.push({
        hookId: definition.id,
        action: result.action,
        ...(result.reason ? { reason: result.reason } : {}),
        annotations: structuredClone(result.annotations ?? {}),
        evidence: [...(result.evidence ?? [])],
        warnings: [...(result.warnings ?? [])],
      });
      if (action !== 'block' && result.action === 'block') {
        action = 'block';
        reason = result.reason ?? `Hook blocked operation: ${definition.id}`;
      }
    }

    return {
      event: context.event,
      action,
      ...(reason ? { reason } : {}),
      annotations,
      evidence,
      warnings,
      executions,
    };
  }

  private async execute(definition: HookDefinition, context: HookContext): Promise<HookResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Hook ${definition.id} timed out after ${definition.timeoutMs}ms`)), definition.timeoutMs);
      });
      const result = await Promise.race([definition.handler(structuredClone(context)), timeout]);
      if (result.hookId !== definition.id) throw new Error(`Hook ${definition.id} returned mismatched hookId ${result.hookId}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (definition.critical) return { hookId: definition.id, action: 'block', reason: message, warnings: [message] };
      return { hookId: definition.id, action: 'continue', warnings: [message] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
