import { access, constants } from 'node:fs/promises';
import type { ProcessRunner } from '../process.js';
import type { CodingAgentAdapter, CodingAgentRequest, CodingAgentResult } from './base.js';

export interface CodexCliAdapterOptions {
  executable: string;
  runner: ProcessRunner;
  isolation: 'helix' | 'codex';
  environment?: Record<string, string>;
  model?: string;
  profile?: string;
}

interface ParsedCodexEvents {
  threadId?: string;
  output: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode?: number }>;
  tokens: number;
  eventCount: number;
  error?: string;
}

export class CodexCliAdapter implements CodingAgentAdapter {
  readonly name = 'codex';
  private readonly executable: string;
  private readonly runner: ProcessRunner;
  private readonly isolation: CodexCliAdapterOptions['isolation'];
  private readonly environment: Record<string, string> | undefined;
  private readonly model: string | undefined;
  private readonly profile: string | undefined;

  constructor(options: CodexCliAdapterOptions) {
    if (!options.executable.trim()) throw new Error('Codex executable is required');
    if (options.model !== undefined && !options.model.trim()) throw new Error('Codex model must not be empty');
    if (options.profile !== undefined && !options.profile.trim()) throw new Error('Codex profile must not be empty');
    if (options.isolation === 'helix' && options.runner.isolated !== true) {
      throw new Error('Codex sandbox bypass requires a proven isolated Helix process runner');
    }
    this.executable = options.executable;
    this.runner = options.runner;
    this.isolation = options.isolation;
    this.environment = options.environment;
    this.model = options.model;
    this.profile = options.profile;
  }

  async available(): Promise<boolean> {
    try {
      await access(this.executable, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    return this.execute(request);
  }

  async resume(sessionRef: string, request: CodingAgentRequest): Promise<CodingAgentResult> {
    if (!sessionRef.trim()) throw new Error('Codex sessionRef is required for resume');
    return this.execute(request, sessionRef);
  }

  private async execute(request: CodingAgentRequest, sessionRef?: string): Promise<CodingAgentResult> {
    const args = this.argumentsFor(sessionRef);
    const result = await this.runner.run({
      executable: this.executable,
      args,
      cwd: request.cwd,
      stdin: contextualPrompt(request),
      ...(this.environment ? { environment: this.environment } : {}),
      timeoutMs: request.timeoutMs,
    });

    const parsed = parseCodexJsonl(result.stdout, sessionRef);
    const processSucceeded = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const success = processSucceeded && parsed.error === undefined;
    const error = parsed.error
      ?? (!processSucceeded
        ? result.stderr || (result.timedOut
          ? 'Codex timed out'
          : result.cancelled
            ? 'Codex cancelled'
            : `Codex exited with ${result.exitCode}`)
        : undefined);

    return {
      adapter: this.name,
      success,
      output: parsed.output,
      ...(parsed.threadId ? { sessionRef: parsed.threadId } : {}),
      changedFiles: parsed.changedFiles,
      commands: parsed.commands,
      usage: { tokens: parsed.tokens },
      structured: {
        eventCount: parsed.eventCount,
        tokens: parsed.tokens,
        ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
      },
      ...(error ? { error } : {}),
    };
  }

  private argumentsFor(sessionRef?: string): string[] {
    const args = ['exec', '--json', '--color', 'never'];
    if (this.isolation === 'helix') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('--sandbox', 'workspace-write');
    if (this.model) args.push('--model', this.model);
    if (this.profile) args.push('--profile', this.profile);
    if (sessionRef) args.push('resume', sessionRef);
    args.push('-');
    return args;
  }
}

function contextualPrompt(request: CodingAgentRequest): string {
  if (!request.context.length) return request.prompt;
  return `${request.prompt}\n\nHelix context:\n${request.context.map((item) => `[${item.kind}] ${item.content}`).join('\n')}`;
}

function parseCodexJsonl(stdout: string, resumedThreadId?: string): ParsedCodexEvents {
  const parsed: ParsedCodexEvents = {
    ...(resumedThreadId ? { threadId: resumedThreadId } : {}),
    output: '',
    changedFiles: [],
    commands: [],
    tokens: 0,
    eventCount: 0,
  };
  const files = new Set<string>();

  for (const [index, rawLine] of stdout.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return { ...parsed, changedFiles: [...files], error: `Invalid Codex JSONL at line ${index + 1}` };
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      return { ...parsed, changedFiles: [...files], error: `Invalid Codex JSONL event at line ${index + 1}` };
    }
    parsed.eventCount += 1;

    if (event.type === 'thread.started') {
      if (typeof event.thread_id !== 'string' || !event.thread_id.trim()) {
        return { ...parsed, changedFiles: [...files], error: 'Invalid Codex thread.started event' };
      }
      parsed.threadId = event.thread_id;
      continue;
    }

    if (event.type === 'turn.failed' || event.type === 'error') {
      const message = event.type === 'turn.failed' && isRecord(event.error) && typeof event.error.message === 'string'
        ? event.error.message
        : typeof event.message === 'string'
          ? event.message
          : 'Codex turn failed';
      parsed.error = message;
      continue;
    }

    if (event.type === 'turn.completed' && isRecord(event.usage)) {
      const input = finiteNonNegative(event.usage.input_tokens);
      const output = finiteNonNegative(event.usage.output_tokens);
      parsed.tokens += input + output;
      continue;
    }

    if (event.type !== 'item.completed' || !isRecord(event.item) || typeof event.item.type !== 'string') continue;
    const item = event.item;
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      parsed.output = item.text;
      continue;
    }
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      parsed.commands.push({
        command: item.command,
        ...(typeof item.exit_code === 'number' && Number.isInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
      });
      continue;
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (isRecord(change) && typeof change.path === 'string' && change.path.trim()) files.add(change.path);
      }
    }
  }

  parsed.changedFiles = [...files];
  if (!parsed.threadId) parsed.error = parsed.error ?? 'Codex JSONL did not emit thread.started';
  return parsed;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
