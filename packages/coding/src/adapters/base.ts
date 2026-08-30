export interface CodingAgentRequest {
  sessionId: string;
  goal: string;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  deniedTools: string[];
  maxTurns: number;
  timeoutMs: number;
  context: Array<{ kind: string; content: string }>;
}

export interface CodingAgentResult {
  adapter: string;
  success: boolean;
  output: string;
  structured?: Record<string, unknown>;
  sessionRef?: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode?: number }>;
  usage?: { tokens?: number; costUsd?: number };
  error?: string;
}

export interface CodingAgentAdapter {
  readonly name: string;
  available(): Promise<boolean>;
  run(request: CodingAgentRequest): Promise<CodingAgentResult>;
  resume?(sessionRef: string, request: CodingAgentRequest): Promise<CodingAgentResult>;
}

export class DeterministicCodingAdapter implements CodingAgentAdapter {
  readonly name = 'deterministic';
  async available(): Promise<boolean> { return true; }
  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    return {
      adapter: this.name,
      success: true,
      output: `Deterministic coding pass prepared for: ${request.goal}`,
      structured: { goal: request.goal, contextItems: request.context.length, maxTurns: request.maxTurns },
      changedFiles: [],
      commands: [],
      usage: { tokens: 0, costUsd: 0 },
    };
  }
}
