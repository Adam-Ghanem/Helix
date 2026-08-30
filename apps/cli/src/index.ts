#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  BoundedProcessRunner,
  ClaudeCodeAdapter,
  CodingAgentAdapter,
  CodingHarness,
  CodingSessionStore,
  DeterministicCodingAdapter,
  GenericCliAdapter,
  createCommandSafetyHook,
  createEditContextHook,
  createQualityGateHook,
  createTaskPreparationHook,
} from '../../../packages/coding/src/index.js';
import { daemonPaths, enqueueExecution, readDaemonStatus, requestDaemonStop } from '../../../packages/daemon/src/index.js';
import { HookEngine, HookEventName } from '../../../packages/hooks/src/index.js';
import { HelixRuntime, HttpModelProvider } from '../../../packages/runtime/src/index.js';
import { DurableTaskQueue } from '../../../packages/workers/src/index.js';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const modelProvider = process.env.HELIX_MODEL_API_URL && process.env.HELIX_MODEL_API_KEY && process.env.HELIX_MODEL
  ? new HttpModelProvider({ endpoint: process.env.HELIX_MODEL_API_URL, apiKey: process.env.HELIX_MODEL_API_KEY, model: process.env.HELIX_MODEL })
  : undefined;
const runtime = new HelixRuntime({ dataDirectory, ...(modelProvider ? { provider: modelProvider } : {}) });

function print(value: unknown): void {
  if (jsonOutput) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function help(): void {
  console.log(`HELIX — Coordinate Intelligence\n\nUsage:\n  helix run <goal> [--background] [--json]\n  helix code run <goal> [--adapter <name>] [--json]\n  helix code resume <session-id> [--adapter <name>] [--json]\n  helix code session <session-id> [--json]\n  helix code sessions [--json]\n  helix hooks list [--json]\n  helix hooks run <event> --session <id> [--payload <json>] [--json]\n  helix daemon <start|status|stop> [--json]\n  helix jobs [--json]\n  helix job <id> [--json]\n  helix agents [--json]\n  helix events [--json]\n  helix execution <id> <pause|resume|cancel|retry|checkpoint> [--json]\n  helix approvals [list|approve|deny] [id] [--json]\n  helix verify [--json]\n  helix recover [--json]\n  helix benchmark [--agents N] [--json]`);
}

async function main(): Promise<void> {
  const command = args[0];
  if (!command || command === '--help' || command === 'help') return help();

  if (command === 'daemon') return handleDaemonCommand();
  if (command === 'jobs' || command === 'job') return handleJobCommand(command);

  await runtime.init();
  if (command === 'code') return handleCodeCommand();
  if (command === 'hooks') return handleHooksCommand();
  if (command === 'run') {
    const background = args.includes('--background');
    const goal = args.filter((arg, index) => index > 0 && arg !== '--json' && arg !== '--background').join(' ').trim();
    if (!goal) throw new Error('A goal is required. Example: helix run "Analyze this repository"');
    if (background) {
      const job = await enqueueExecution(dataDirectory, { goal });
      const daemon = await readDaemonStatus(dataDirectory);
      return print({ job, daemonRunning: daemon?.running ?? false });
    }
    const execution = await runtime.execute({ goal });
    if (jsonOutput) return print(execution);
    console.log('HELIX');
    console.log('──────────────────────────────────────');
    console.log(`Execution: ${execution.id}`);
    console.log(`Status:    ${execution.status}`);
    console.log(`Tasks:     ${execution.usage.tasks}`);
    console.log(`Completed: ${execution.result && typeof execution.result === 'object' ? (execution.result as { completedTasks?: number }).completedTasks ?? 0 : 0}`);
    console.log(`Cost:      $${execution.usage.costUsd.toFixed(4)}`);
    console.log(`Tokens:    ${execution.usage.tokens}`);
    return;
  }
  if (command === 'agents') return print({ agents: runtime.agents.list() });
  if (command === 'events') return print({ events: await runtime.events.read() });
  if (command === 'execution') {
    const executionId = args[1];
    const action = args[2];
    if (!executionId || !['pause', 'resume', 'cancel', 'retry', 'checkpoint'].includes(action ?? '')) throw new Error('Usage: helix execution <id> <pause|resume|cancel|retry|checkpoint>');
    if (action === 'pause') return print(await runtime.pause(executionId));
    if (action === 'resume') return print(await runtime.resume(executionId));
    if (action === 'cancel') return print(await runtime.cancel(executionId));
    if (action === 'retry') return print(await runtime.retry(executionId));
    return print(await runtime.checkpoint(executionId));
  }
  if (command === 'approvals') {
    const action = args[1] ?? 'list';
    const approvalId = args[2];
    if (action === 'list') return print({ approvals: runtime.policy.listApprovals() });
    if (!approvalId || !['approve', 'deny'].includes(action)) throw new Error('Usage: helix approvals <list|approve|deny> [id]');
    const approval = action === 'approve' ? runtime.policy.approve(approvalId, 'cli-user') : runtime.policy.deny(approvalId, 'cli-user');
    await runtime.events.append({ type: `approval.${approval.status}`, executionId: approval.executionId, agentId: approval.requestedBy, payload: approval });
    return print(approval);
  }
  if (command === 'verify') return print({ ok: true, sequence: runtime.events.lastSequence, provider: runtime.provider.name, dataDirectory });
  if (command === 'recover') return print({ recovered: await runtime.recover(), sequence: runtime.events.lastSequence });
  if (command === 'benchmark') {
    const count = Number(args[args.indexOf('--agents') + 1] ?? 10);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--agents must be an integer from 1 to 100');
    const started = performance.now();
    const execution = await runtime.execute({ goal: `Benchmark bounded swarm with ${count} agents`, budget: { maxAgents: count, maxTasks: 64 } });
    return print({ agents: count, executionId: execution.id, status: execution.status, elapsedMs: Math.round(performance.now() - started), tasks: execution.usage.tasks });
  }
  throw new Error(`Unknown command: ${command}`);
}

async function handleCodeCommand(): Promise<void> {
  const action = args[1];
  const store = new CodingSessionStore({ stateFile: join(dataDirectory, 'coding.sessions.json') });
  await store.init();
  if (action === 'sessions') return print({ sessions: await store.listSessions() });
  if (action === 'session') {
    const sessionId = args[2];
    if (!sessionId) throw new Error('Usage: helix code session <session-id>');
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`Unknown coding session: ${sessionId}`);
    return print({ session, evidence: await store.evidenceForSession(sessionId) });
  }
  if (action !== 'run' && action !== 'resume') throw new Error('Usage: helix code <run|resume|session|sessions> ...');
  const adapterName = optionValue('--adapter') ?? process.env.HELIX_CODE_ADAPTER ?? 'deterministic';
  const adapter = createCodingAdapter(adapterName);
  const hooks = createCodingHooks(store);
  const harness = new CodingHarness({
    store,
    hooks,
    adapter,
    memory: runtime.memory,
    agents: runtime.agents,
    reviewer: async ({ implementation }) => ({ approved: implementation.success, findings: [], summary: implementation.success ? 'Adapter execution completed; no structured reviewer findings were configured.' : 'Adapter execution failed.' }),
    tester: async () => ({ passed: true, commands: [], summary: 'No HELIX_CODE_VERIFY commands configured; structural harness verification only.' }),
    judge: async ({ implementation, review, test }) => ({ accepted: implementation.success && review.approved && test.passed, reason: implementation.success ? 'Configured coding harness gates passed.' : 'Implementation adapter failed.', requiredFixes: [], confidence: implementation.success ? 0.75 : 0 }),
  });
  if (action === 'resume') {
    const sessionId = args[2];
    if (!sessionId) throw new Error('Usage: helix code resume <session-id>');
    return print(await harness.resume(sessionId));
  }
  const goal = positionalAfter(2, new Set(['--adapter']));
  if (!goal) throw new Error('Usage: helix code run <goal> [--adapter <name>]');
  return print(await harness.run({ goal, cwd: process.env.HELIX_CODE_CWD ?? process.cwd() }));
}

async function handleHooksCommand(): Promise<void> {
  const action = args[1] ?? 'list';
  const store = new CodingSessionStore({ stateFile: join(dataDirectory, 'coding.sessions.json') });
  await store.init();
  const hooks = createCodingHooks(store);
  if (action === 'list') return print({ hooks: hooks.list().map((hook) => ({ id: hook.id, events: hook.events, priority: hook.priority, critical: hook.critical, timeoutMs: hook.timeoutMs, alwaysRun: hook.alwaysRun ?? false })) });
  if (action !== 'run') throw new Error('Usage: helix hooks <list|run> ...');
  const event = args[2];
  const sessionId = optionValue('--session');
  if (!isHookEvent(event)) throw new Error(`Unknown hook event: ${event ?? ''}`);
  if (!sessionId) throw new Error('helix hooks run requires --session <id>');
  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`Unknown coding session: ${sessionId}`);
  let payload: Record<string, unknown> = {};
  const rawPayload = optionValue('--payload');
  if (rawPayload) {
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('payload must be a JSON object');
      payload = parsed as Record<string, unknown>;
    } catch (error) { throw new Error(`Invalid hook payload: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return print(await hooks.run({ event, sessionId, cwd: session.cwd, timestamp: new Date().toISOString(), payload, metadata: { source: 'cli' } }));
}

function createCodingHooks(_store: CodingSessionStore): HookEngine {
  const hooks = new HookEngine();
  const workspaceRoot = process.env.HELIX_CODE_WORKSPACE_ROOT ?? process.cwd();
  hooks.register(createCommandSafetyHook({ deniedPatterns: [/\brm\s+-rf\s+\/(?:\s|$)/i, /:\(\)\s*\{/] }));
  hooks.register(createEditContextHook({ workspaceRoots: [workspaceRoot], memory: runtime.memory }));
  hooks.register(createTaskPreparationHook({ memory: runtime.memory, agents: runtime.agents }));
  hooks.register(createQualityGateHook());
  return hooks;
}

function createCodingAdapter(name: string): CodingAgentAdapter {
  if (name === 'deterministic') return new DeterministicCodingAdapter();
  const workspaceRoot = process.env.HELIX_CODE_WORKSPACE_ROOT ?? process.cwd();
  if (name === 'claude' || name === 'claude-code') {
    const executable = process.env.HELIX_CLAUDE_EXECUTABLE;
    if (!executable || !isAbsolute(executable)) throw new Error('HELIX_CLAUDE_EXECUTABLE must be an absolute executable path');
    const envKeys = environmentKeys();
    return new ClaudeCodeAdapter({ executable, runner: processRunner(executable, workspaceRoot, envKeys), environment: environmentValues(envKeys) });
  }
  if (name === 'generic') {
    const executable = process.env.HELIX_CODE_EXECUTABLE;
    if (!executable || !isAbsolute(executable)) throw new Error('HELIX_CODE_EXECUTABLE must be an absolute executable path');
    const envKeys = environmentKeys();
    const staticArgs = parseStringArray(process.env.HELIX_CODE_ARGS, 'HELIX_CODE_ARGS');
    const promptTransport = process.env.HELIX_CODE_PROMPT_TRANSPORT === 'argv' ? 'argv' : 'stdin';
    return new GenericCliAdapter({
      name: process.env.HELIX_CODE_ADAPTER_NAME ?? 'generic', runner: processRunner(executable, workspaceRoot, envKeys), executable, staticArgs, promptTransport, environment: environmentValues(envKeys),
      parse: (stdout) => {
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          return {
            structured: parsed,
            changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.filter((value): value is string => typeof value === 'string') : [],
            commands: Array.isArray(parsed.commands) ? parsed.commands.filter((value): value is { command: string; exitCode?: number } => Boolean(value) && typeof value === 'object' && typeof (value as { command?: unknown }).command === 'string') : [],
            ...(typeof parsed.sessionRef === 'string' ? { sessionRef: parsed.sessionRef } : {}),
          };
        } catch { return {}; }
      },
    });
  }
  throw new Error(`Unknown coding adapter: ${name}`);
}

function processRunner(executable: string, workspaceRoot: string, envKeys: string[]): BoundedProcessRunner {
  return new BoundedProcessRunner({ allowedExecutables: [executable], workspaceRoots: [workspaceRoot], environmentKeys: envKeys, maxStdoutBytes: 1_048_576, maxStderrBytes: 262_144, killGraceMs: 250 });
}

function environmentKeys(): string[] {
  return (process.env.HELIX_CODE_ENV_KEYS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}
function environmentValues(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
function parseStringArray(raw: string | undefined, name: string): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('must be a JSON string array');
    return value;
  } catch (error) { throw new Error(`${name} must be a JSON string array: ${error instanceof Error ? error.message : String(error)}`); }
}
function optionValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function positionalAfter(start: number, valueFlags: Set<string>): string {
  const values: string[] = [];
  for (let index = start; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === '--json') continue;
    if (valueFlags.has(value)) { index += 1; continue; }
    if (value.startsWith('--')) continue;
    values.push(value);
  }
  return values.join(' ').trim();
}
function isHookEvent(value: string | undefined): value is HookEventName {
  return Boolean(value && ['session-start', 'session-end', 'pre-task', 'post-task', 'pre-edit', 'post-edit', 'pre-command', 'post-command', 'pre-tool', 'post-tool', 'on-failure', 'pre-review', 'post-review'].includes(value));
}

async function handleDaemonCommand(): Promise<void> {
  const action = args[1] ?? 'status';
  if (!['start', 'status', 'stop'].includes(action)) throw new Error('Usage: helix daemon <start|status|stop>');
  if (action === 'status') {
    const status = await readDaemonStatus(dataDirectory);
    return print(status ?? { running: false, dataDirectory });
  }
  if (action === 'stop') {
    const requested = await requestDaemonStop(dataDirectory);
    if (!requested) return print({ running: false, stopped: false, reason: 'daemon is not running' });
    const stopped = await waitForDaemon(false);
    return print({ running: !stopped, stopped });
  }

  const existing = await readDaemonStatus(dataDirectory);
  if (existing?.running) return print(existing);
  const entrypoint = daemonEntrypoint();
  const child = spawn(process.execPath, [...process.execArgv, entrypoint], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HELIX_DATA_DIR: dataDirectory },
  });
  child.unref();
  const started = await waitForDaemon(true);
  if (!started) throw new Error('Helix daemon did not report a healthy startup');
  return print(await readDaemonStatus(dataDirectory));
}

async function handleJobCommand(command: 'jobs' | 'job'): Promise<void> {
  const queue = new DurableTaskQueue({ stateFile: daemonPaths(dataDirectory).queueFile });
  await queue.init();
  if (command === 'jobs') return print({ jobs: await queue.list() });
  const jobId = args[1];
  if (!jobId) throw new Error('Usage: helix job <id>');
  return print(await queue.get(jobId));
}

function daemonEntrypoint(): string {
  const cliPath = fileURLToPath(import.meta.url);
  const extension = extname(cliPath);
  if (extension !== '.ts' && extension !== '.js') throw new Error(`Unsupported CLI module extension: ${extension}`);
  return resolve(dirname(cliPath), '../../daemon/src', `index${extension}`);
}

async function waitForDaemon(expectedRunning: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await readDaemonStatus(dataDirectory);
    if ((status?.running ?? false) === expectedRunning) return true;
    await sleep(50);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(`helix: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
