import { performance } from 'node:perf_hooks';
import { BoundedProcessRunner } from './process.js';
import { CodingEvidenceRecord, JudgeVerdict, ReviewVerdict, TestVerdict } from './types.js';

export interface VerificationCommand {
  name?: string;
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  environment?: Record<string, string>;
}

export class VerificationRunner {
  constructor(private readonly options: { runner: BoundedProcessRunner; defaultTimeoutMs?: number }) {}

  async run(commands: VerificationCommand[]): Promise<TestVerdict> {
    const results: TestVerdict['commands'] = [];
    const reasons: string[] = [];
    let passed = true;
    for (const command of commands) {
      const started = performance.now();
      const display = command.name?.trim() || [command.executable, ...command.args].join(' ');
      try {
        const result = await this.options.runner.run({
          executable: command.executable,
          args: [...command.args],
          cwd: command.cwd ?? process.cwd(),
          ...(command.environment ? { environment: command.environment } : {}),
          timeoutMs: command.timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000,
        });
        results.push({ command: display, exitCode: result.exitCode, durationMs: Math.max(0, Math.round(performance.now() - started)) });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
          passed = false;
          reasons.push(`${display}: ${result.timedOut ? 'timed out' : result.cancelled ? 'cancelled' : `exit ${result.exitCode}`}`);
        }
      } catch (error) {
        passed = false;
        results.push({ command: display, exitCode: -1, durationMs: Math.max(0, Math.round(performance.now() - started)) });
        reasons.push(`${display}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!commands.length) return { passed: true, commands: [], summary: 'No verification commands configured.' };
    return { passed, commands: results, summary: passed ? `All ${results.length} verification command(s) passed.` : `Verification failed: ${reasons.join('; ')}` };
  }
}

export interface QualityModelRequest {
  system: string;
  prompt: string;
  timeoutMs: number;
}

export interface QualityModel {
  complete(request: QualityModelRequest): Promise<string>;
}

export class HttpQualityModel implements QualityModel {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: { endpoint: string; apiKey: string; model: string; timeoutMs?: number }) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async complete(request: QualityModelRequest): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, request.timeoutMs));
    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
        }),
      });
      if (!response.ok) throw new Error(`Quality model returned HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('Quality model returned no assistant content');
      return content;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`Quality model timed out after ${Math.min(this.timeoutMs, request.timeoutMs)}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ReviewerInput {
  goal: string;
  output: string;
  evidence: CodingEvidenceRecord[];
}

export class ModelReviewer {
  constructor(private readonly options: { model: QualityModel; timeoutMs?: number }) {}

  async review(input: ReviewerInput): Promise<ReviewVerdict> {
    const system = 'You are Helix code reviewer. Return ONLY JSON with keys approved:boolean, findings:[{severity:info|low|medium|high|critical,message:string,file?:string}], summary:string.';
    const prompt = JSON.stringify({ goal: input.goal, implementation: input.output, evidence: compactEvidence(input.evidence) });
    try {
      const raw = await this.options.model.complete({ system, prompt, timeoutMs: this.options.timeoutMs ?? 60_000 });
      return parseReview(raw);
    } catch (error) {
      return invalidReview(error);
    }
  }
}

interface JudgeInput {
  goal: string;
  review: ReviewVerdict;
  test: TestVerdict;
  evidence: CodingEvidenceRecord[];
}

export class ModelJudge {
  constructor(private readonly options: { model: QualityModel; timeoutMs?: number }) {}

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    if (!authoritativeTestsPassed(input.test)) {
      return { accepted: false, reason: 'Authoritative verification failed.', requiredFixes: ['Fix failing verification commands.'], confidence: 1 };
    }
    if (input.review.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical')) {
      return { accepted: false, reason: 'Reviewer reported unresolved high-severity findings.', requiredFixes: input.review.findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical').map((finding) => finding.message), confidence: 1 };
    }
    const system = 'You are Helix quality judge. Return ONLY JSON with keys accepted:boolean, reason:string, requiredFixes:string[], confidence:number between 0 and 1.';
    const prompt = JSON.stringify({ goal: input.goal, review: input.review, test: input.test, evidence: compactEvidence(input.evidence) });
    try {
      const raw = await this.options.model.complete({ system, prompt, timeoutMs: this.options.timeoutMs ?? 60_000 });
      return parseJudge(raw);
    } catch (error) {
      return invalidJudge(error);
    }
  }
}

function parseReview(raw: string): ReviewVerdict {
  try {
    const value = JSON.parse(stripFence(raw)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidReview(new Error('reviewer output is not an object'));
    const record = value as Record<string, unknown>;
    if (typeof record.approved !== 'boolean' || typeof record.summary !== 'string' || !Array.isArray(record.findings)) return invalidReview(new Error('reviewer output is missing required fields'));
    const findings: ReviewVerdict['findings'] = [];
    for (const candidate of record.findings) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return invalidReview(new Error('review finding is invalid'));
      const finding = candidate as Record<string, unknown>;
      if (!isSeverity(finding.severity) || typeof finding.message !== 'string') return invalidReview(new Error('review finding fields are invalid'));
      if (finding.file !== undefined && typeof finding.file !== 'string') return invalidReview(new Error('review finding file is invalid'));
      findings.push({ severity: finding.severity, message: finding.message, ...(typeof finding.file === 'string' ? { file: finding.file } : {}) });
    }
    return { approved: record.approved, findings, summary: record.summary };
  } catch (error) {
    return invalidReview(error);
  }
}

function parseJudge(raw: string): JudgeVerdict {
  try {
    const value = JSON.parse(stripFence(raw)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidJudge(new Error('judge output is not an object'));
    const record = value as Record<string, unknown>;
    if (typeof record.accepted !== 'boolean' || typeof record.reason !== 'string' || !Array.isArray(record.requiredFixes) || typeof record.confidence !== 'number') return invalidJudge(new Error('judge output is missing required fields'));
    if (!record.requiredFixes.every((item) => typeof item === 'string')) return invalidJudge(new Error('judge requiredFixes must be strings'));
    return { accepted: record.accepted, reason: record.reason, requiredFixes: record.requiredFixes as string[], confidence: clamp(record.confidence) };
  } catch (error) {
    return invalidJudge(error);
  }
}

function invalidReview(error: unknown): ReviewVerdict {
  const message = error instanceof Error ? error.message : String(error);
  return { approved: false, findings: [{ severity: 'critical', message: `Invalid reviewer model output: ${message}` }], summary: `Invalid reviewer model output: ${message}` };
}

function invalidJudge(error: unknown): JudgeVerdict {
  const message = error instanceof Error ? error.message : String(error);
  return { accepted: false, reason: `Invalid judge model output: ${message}`, requiredFixes: ['Obtain a valid structured judge verdict.'], confidence: 0 };
}

function authoritativeTestsPassed(test: TestVerdict): boolean {
  return test.passed && test.commands.every((command) => command.exitCode === 0);
}

function compactEvidence(evidence: CodingEvidenceRecord[]): Array<{ type: string; data: Record<string, unknown> }> {
  return evidence.slice(-30).map((record) => ({ type: record.type, data: record.data }));
}

function isSeverity(value: unknown): value is ReviewVerdict['findings'][number]['severity'] {
  return typeof value === 'string' && ['info', 'low', 'medium', 'high', 'critical'].includes(value);
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
