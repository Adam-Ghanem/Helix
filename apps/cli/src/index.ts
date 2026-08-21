#!/usr/bin/env node
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HelixRuntime, HttpModelProvider } from '../../../packages/runtime/src/index.js';
import { defaultSandboxPolicy, dockerAvailable } from '../../../packages/sandbox/src/index.js';

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
  console.log(`HELIX — Coordinate Intelligence\n\nUsage:\n  helix run <goal> [--json]\n  helix agents [--json]\n  helix events [--json]\n  helix execution <id> <pause|resume|cancel|retry|checkpoint> [--json]\n  helix approvals [list|approve|deny] [id] [--json]\n  helix sandbox doctor [--json]\n  helix sandbox run [--docker] [--network none] [--memory MB] [--timeout 10s] -- <command> [args...]\n  helix sandbox status [--json]\n  helix sandbox destroy <id> [--json]
  helix memory search "<query>" [--json]
  helix memory list [--json]
  helix memory inspect <id> [--json]
  helix memory stats [--json]
  helix learning agent <agentId> [--json]
  helix learning hints "<task>" [--json]
  helix verify [--json]\n  helix recover [--json]\n  helix benchmark [--agents N] [--json]`);
}

async function main(): Promise<void> {
  await runtime.init();
  const command = args[0];
  if (!command || command === '--help' || command === 'help') return help();
  if (command === 'run') {
    const goal = args.filter((arg, index) => index > 0 && arg !== '--json').join(' ').trim();
    if (!goal) throw new Error('A goal is required. Example: helix run "Analyze this repository"');
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
  if (command === 'memory') {
    const action = args[1];
    const context = { subject: process.env.HELIX_SUBJECT ?? 'cli-user' };
    if (action === 'search') { const query = args.slice(2).filter((arg) => arg !== '--json').join(' ').trim(); if (!query) throw new Error('Usage: helix memory search "<query>"'); return print(await runtime.searchMemory({ query, limit: 20, context })); }
    if (action === 'list') return print(await runtime.memory.listEntries(context));
    if (action === 'inspect') { if (!args[2]) throw new Error('Usage: helix memory inspect <id>'); return print(await runtime.getMemory(args[2], context)); }
    if (action === 'stats') return print(await runtime.memoryStats(context));
    throw new Error('Usage: helix memory <search|list|inspect|stats>');
  }
  if (command === 'learning') {
    const action = args[1];
    if (action === 'agent') { if (!args[2]) throw new Error('Usage: helix learning agent <agentId>'); return print(await runtime.agentExperience(args[2])); }
    if (action === 'hints') { const task = args.slice(2).filter((arg) => arg !== '--json').join(' ').trim(); if (!task) throw new Error('Usage: helix learning hints "<task>"'); return print(await runtime.learningHints(task, ['analysis'], { subject: process.env.HELIX_SUBJECT ?? 'cli-user' })); }
    throw new Error('Usage: helix learning <agent|hints>');
  }
  if (command === 'sandbox') {
    const action = args[1];
    if (action === 'doctor') return print({ local: { available: true, networkDefault: 'none', isolation: 'best-effort' }, docker: { available: await dockerAvailable(), requiredFlags: ['--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit', '--memory', '--cpus', '--network none'] } });
    if (action === 'status') return print({ sandboxes: runtime.sandbox.list() });
    if (action === 'destroy') { if (!args[2]) throw new Error('Usage: helix sandbox destroy <id>'); return print(await runtime.sandbox.destroy(args[2])); }
    if (action === 'run') {
      const separator = args.indexOf('--');
      if (separator < 0 || !args[separator + 1]) throw new Error('Usage: helix sandbox run [options] -- <command> [args...]');
      const commandName = args[separator + 1]!;
      const commandArgs = args.slice(separator + 2);
      const workspace = process.env.HELIX_SANDBOX_WORKSPACE ?? process.cwd();
      const timeoutText = args[args.indexOf('--timeout') + 1] ?? '30s';
      const timeoutMatch = timeoutText.match(/^(\d+)(ms|s|m)$/);
      if (!timeoutMatch) throw new Error('--timeout must use ms, s, or m');
      const timeoutUnits = Number(timeoutMatch[1]);
      const timeoutMs = timeoutMatch[2] === 'm' ? timeoutUnits * 60_000 : timeoutMatch[2] === 's' ? timeoutUnits * 1_000 : timeoutUnits;
      const network = args[args.indexOf('--network') + 1] ?? 'none';
      if (!['none', 'host', 'bridge', 'custom'].includes(network)) throw new Error('--network must be none, host, bridge, or custom');
      const memoryLimitMb = Number(args[args.indexOf('--memory') + 1] ?? 512);
      if (!Number.isFinite(memoryLimitMb) || memoryLimitMb <= 0) throw new Error('--memory must be positive');
      const sandboxPolicy = { ...defaultSandboxPolicy(workspace), allowedExecutables: [commandName], timeoutMs, memoryLimitMb, networkMode: network as 'none' | 'host' | 'bridge' | 'custom', allowNetwork: network !== 'none' };
      const created = await runtime.sandbox.create({ policy: sandboxPolicy, backend: args.includes('--docker') ? 'docker' : 'local' });
      try { await runtime.sandbox.start(created.sandboxId); return print(await runtime.sandbox.exec(created.sandboxId, { command: commandName, args: commandArgs, cwd: '.', env: {} })); }
      finally { await runtime.sandbox.destroy(created.sandboxId); }
    }
    throw new Error('Usage: helix sandbox <doctor|run|status|destroy>');
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

main().catch((error: unknown) => {
  console.error(`helix: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
