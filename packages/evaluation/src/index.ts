export type EvaluationKind = 'rule' | 'schema' | 'test' | 'llm-judge' | 'human';

export interface EvaluationInput {
  output: unknown;
  context?: Record<string, unknown>;
}

export interface EvaluationResult {
  evaluator: EvaluationKind;
  passed: boolean;
  quality: number;
  reasons: string[];
  authoritative: boolean;
}

export type Evaluator = (input: EvaluationInput) => Promise<EvaluationResult>;

export class EvaluationEngine {
  private readonly evaluators = new Map<string, { kind: EvaluationKind; evaluator: Evaluator }>();

  register(name: string, kind: EvaluationKind, evaluator: Evaluator): void {
    if (this.evaluators.has(name)) throw new Error(`Evaluator already registered: ${name}`);
    this.evaluators.set(name, { kind, evaluator });
  }

  async evaluate(input: EvaluationInput, names?: string[]): Promise<EvaluationResult[]> {
    const selected = names?.length ? names.map((name) => this.evaluators.get(name)).filter((item): item is { kind: EvaluationKind; evaluator: Evaluator } => Boolean(item)) : [...this.evaluators.values()];
    if (!selected.length) throw new Error('No evaluators registered');
    const results = await Promise.all(selected.map(async ({ kind, evaluator }) => {
      const result = await evaluator(input);
      return { ...result, evaluator: kind, authoritative: kind !== 'llm-judge' && result.authoritative };
    }));
    return results;
  }

  registerRule(name: string, rule: (output: unknown) => boolean, reason: string): void {
    this.register(name, 'rule', async ({ output }) => { const passed = rule(output); return { evaluator: 'rule', passed, quality: passed ? 1 : 0, reasons: [reason], authoritative: true }; });
  }

  registerSchema(name: string, requiredKeys: string[]): void {
    this.register(name, 'schema', async ({ output }) => {
      const object = typeof output === 'object' && output !== null ? output as Record<string, unknown> : {};
      const missing = requiredKeys.filter((key) => !(key in object));
      return { evaluator: 'schema', passed: missing.length === 0, quality: missing.length === 0 ? 1 : 0, reasons: missing.length ? [`missing keys: ${missing.join(', ')}`] : ['schema valid'], authoritative: true };
    });
  }

  registerTest(name: string, test: (output: unknown) => Promise<boolean>): void {
    this.register(name, 'test', async ({ output }) => { const passed = await test(output); return { evaluator: 'test', passed, quality: passed ? 1 : 0, reasons: [passed ? 'test passed' : 'test failed'], authoritative: true }; });
  }
}
