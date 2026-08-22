import { timestamp } from '../../core/src/index.js';
import type { AgentBudget, BudgetStatus } from './types.js';

export class BudgetTracker {
  readonly startedAt = timestamp();
  private iterations = 0;
  private toolCalls = 0;
  private providerCalls = 0;
  private tokens = 0;
  private costUsd = 0;
  private memoryRecalls = 0;
  private policyDenials = 0;
  private readonly warnings = new Set<string>();
  private readonly exceeded = new Set<string>();

  constructor(readonly budget: AgentBudget, private readonly clock: () => number = Date.now, private readonly startedMs = Date.now()) {}

  iteration(): void { this.iterations += 1; this.check(); }
  providerCall(): void { this.providerCalls += 1; this.check(); }
  toolCall(): void { this.toolCalls += 1; this.check(); }
  memoryRecall(): void { this.memoryRecalls += 1; this.check(); }
  policyDenied(): void { this.policyDenials += 1; this.check(); }
  usage(tokens: number, costUsd: number): void { this.tokens += Math.max(0, tokens); this.costUsd += Math.max(0, costUsd); this.check(); }

  elapsedMs(): number { return Math.max(0, this.clock() - this.startedMs); }
  status(): BudgetStatus {
    const remaining = {
      maxIterations: Math.max(0, this.budget.maxIterations - this.iterations),
      maxToolCalls: Math.max(0, this.budget.maxToolCalls - this.toolCalls),
      maxExecutionTimeMs: Math.max(0, this.budget.maxExecutionTimeMs - this.elapsedMs()),
      maxProviderCalls: Math.max(0, this.budget.maxProviderCalls - this.providerCalls),
      maxTokens: Math.max(0, this.budget.maxTokens - this.tokens),
      maxCostUsd: Math.max(0, this.budget.maxCostUsd - this.costUsd),
      maxMemoryRecalls: Math.max(0, this.budget.maxMemoryRecalls - this.memoryRecalls),
      maxPolicyDenials: Math.max(0, this.budget.maxPolicyDenials - this.policyDenials),
      repeatedToolCallLimit: this.budget.repeatedToolCallLimit,
    };
    return { startedAt: this.startedAt, elapsedMs: this.elapsedMs(), iterations: this.iterations, toolCalls: this.toolCalls, providerCalls: this.providerCalls, tokens: this.tokens, costUsd: this.costUsd, memoryRecalls: this.memoryRecalls, policyDenials: this.policyDenials, remaining, warnings: [...this.warnings], exceeded: [...this.exceeded] };
  }

  assertProviderAllowed(): void { this.check(); if (this.exceeded.has('provider calls') || this.exceeded.has('runtime time') || this.exceeded.has('tokens') || this.exceeded.has('cost')) throw new Error(`agent budget exceeded: ${[...this.exceeded].join(', ')}`); }
  assertMemoryAllowed(): void { this.check(); if (this.exceeded.has('memory recalls') || this.exceeded.has('runtime time')) throw new Error(`agent budget exceeded: ${[...this.exceeded].join(', ')}`); }
  assertToolAllowed(): void { this.check(); if (this.exceeded.has('tool calls') || this.exceeded.has('runtime time') || this.exceeded.has('policy denials')) throw new Error(`agent budget exceeded: ${[...this.exceeded].join(', ')}`); }
  assertIterationAllowed(): void { this.check(); if (this.exceeded.has('iterations') || this.exceeded.has('runtime time')) throw new Error(`agent budget exceeded: ${[...this.exceeded].join(', ')}`); }
  get iterationsCount(): number { return this.iterations; }

  private check(): void {
    const status = this.statusWithoutCheck();
    if (status.iterations >= this.budget.maxIterations) this.exceeded.add('iterations');
    if (status.toolCalls >= this.budget.maxToolCalls) this.exceeded.add('tool calls');
    if (status.providerCalls >= this.budget.maxProviderCalls) this.exceeded.add('provider calls');
    if (status.elapsedMs >= this.budget.maxExecutionTimeMs) this.exceeded.add('runtime time');
    if (status.tokens > this.budget.maxTokens) this.exceeded.add('tokens');
    if (status.costUsd > this.budget.maxCostUsd) this.exceeded.add('cost');
    if (status.memoryRecalls > this.budget.maxMemoryRecalls) this.exceeded.add('memory recalls');
    if (status.policyDenials > this.budget.maxPolicyDenials) this.exceeded.add('policy denials');
    for (const item of this.exceeded) this.warnings.add(item);
  }

  private statusWithoutCheck(): Pick<BudgetStatus, 'elapsedMs' | 'iterations' | 'toolCalls' | 'providerCalls' | 'tokens' | 'costUsd' | 'memoryRecalls' | 'policyDenials'> { return { elapsedMs: this.elapsedMs(), iterations: this.iterations, toolCalls: this.toolCalls, providerCalls: this.providerCalls, tokens: this.tokens, costUsd: this.costUsd, memoryRecalls: this.memoryRecalls, policyDenials: this.policyDenials }; }
}
