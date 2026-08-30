import { access, constants } from 'node:fs/promises';
import type { ProcessRunner } from '../process.js';
import { CodingAgentAdapter, CodingAgentRequest, CodingAgentResult } from './base.js';

export interface GenericCliAdapterOptions {
  name: string;
  runner: ProcessRunner;
  executable: string;
  staticArgs?: string[];
  promptTransport: 'argv' | 'stdin';
  environment?: Record<string, string>;
  parse?: (stdout: string, stderr: string) => Partial<Omit<CodingAgentResult, 'adapter' | 'success' | 'output'>>;
}

export class GenericCliAdapter implements CodingAgentAdapter {
  readonly name: string;
  private readonly options: GenericCliAdapterOptions;

  constructor(options: GenericCliAdapterOptions) {
    if (!options.name.trim()) throw new Error('Generic CLI adapter name is required');
    this.name = options.name;
    this.options = options;
  }

  async available(): Promise<boolean> {
    try { await access(this.options.executable, constants.X_OK); return true; } catch { return false; }
  }

  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    const args = [...(this.options.staticArgs ?? [])];
    const stdin = this.options.promptTransport === 'stdin' ? request.prompt : undefined;
    if (this.options.promptTransport === 'argv') args.push(request.prompt);
    const result = await this.options.runner.run({ executable: this.options.executable, args, cwd: request.cwd, ...(this.options.environment ? { environment: this.options.environment } : {}), ...(stdin !== undefined ? { stdin } : {}), timeoutMs: request.timeoutMs });
    const parsed = this.options.parse?.(result.stdout, result.stderr) ?? {};
    const success = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const fallbackError = result.stderr || (result.timedOut ? 'coding agent timed out' : result.cancelled ? 'coding agent cancelled' : `coding agent exited with ${result.exitCode}`);
    return {
      adapter: this.name,
      success,
      output: result.stdout,
      changedFiles: [],
      commands: [],
      ...parsed,
      ...(success ? {} : { error: parsed.error ?? fallbackError }),
    };
  }
}
