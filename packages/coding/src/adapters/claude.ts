import { access, constants } from 'node:fs/promises';
import { BoundedProcessRunner } from '../process.js';
import { CodingAgentAdapter, CodingAgentRequest, CodingAgentResult } from './base.js';

export class ClaudeCodeAdapter implements CodingAgentAdapter {
  readonly name = 'claude-code';
  private readonly executable: string;
  private readonly runner: BoundedProcessRunner;
  private readonly environment: Record<string, string> | undefined;

  constructor(options: { executable: string; runner: BoundedProcessRunner; environment?: Record<string, string> }) {
    this.executable = options.executable;
    this.runner = options.runner;
    this.environment = options.environment;
  }

  async available(): Promise<boolean> {
    try { await access(this.executable, constants.X_OK); return true; } catch { return false; }
  }

  argumentsFor(request: CodingAgentRequest): string[] {
    const contextualPrompt = request.context.length
      ? `${request.prompt}\n\nHelix context:\n${request.context.map((item) => `[${item.kind}] ${item.content}`).join('\n')}`
      : request.prompt;
    return ['-p', contextualPrompt, '--output-format', 'json'];
  }

  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    const result = await this.runner.run({ executable: this.executable, args: this.argumentsFor(request), cwd: request.cwd, ...(this.environment ? { environment: this.environment } : {}), timeoutMs: request.timeoutMs });
    let structured: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) structured = parsed as Record<string, unknown>;
    } catch { /* keep raw output when the external CLI changes shape */ }
    const success = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const output = typeof structured?.result === 'string' ? structured.result : result.stdout;
    return {
      adapter: this.name,
      success,
      output,
      ...(structured ? { structured } : {}),
      changedFiles: [],
      commands: [],
      ...(!success ? { error: result.stderr || (result.timedOut ? 'Claude Code timed out' : result.cancelled ? 'Claude Code cancelled' : `Claude Code exited with ${result.exitCode}`) } : {}),
    };
  }
}
