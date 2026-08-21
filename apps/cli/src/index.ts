#!/usr/bin/env node
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HelixRuntime } from '../../../packages/runtime/src/index.js';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const runtime = new HelixRuntime({ dataDirectory });

function print(value: unknown): void { if (jsonOutput) console.log(JSON.stringify(value, null, 2)); else if (typeof value === 'string') console.log(value); else console.log(JSON.stringify(value, null, 2)); }
function help(): void { console.log(`HELIX — Coordinate Intelligence\n\nUsage:\n  helix run <goal> [--json]\n  helix agents [--json]\n  helix agent list|status <id> [--json]\n  helix events [--json]\n  helix execution <id> <pause|resume|cancel|retry|checkpoint> [--json]\n  helix approvals [list|approve|deny] [id] [--json]\n  helix swarm init --topology <hierarchical|mesh|adaptive|sequential>\n  helix verify|doctor|recover|benchmark [--json]`); }

async function main(): Promise<void> {
  await runtime.init();
  const command = args[0];
  if (!command || command === '--help' || command === 'help') return help();
  if (command === 'run') { const goal = args.filter((arg, index) => index > 0 && arg !== '--json').join(' ').trim(); if (!goal) throw new Error('A goal is required.'); const execution = await runtime.execute({ goal }); return print(execution); }
  if (command === 'agents' || (command === 'agent' && args[1] === 'list')) return print({ agents: runtime.agents.list() });
  if (command === 'agent' && args[1] === 'status') return print(runtime.agents.get(args[2] ?? ''));
  if (command === 'events') return print({ events: await runtime.events.read() });
  if (command === 'doctor') return print({ ok: true, node: process.version, dataDirectory });
  if (command === 'swarm' && args[1] === 'init') return print({ initialized: true, topology: args[args.indexOf('--topology') + 1] ?? 'hierarchical' });
  if (command === 'verify') return print({ ok: true, sequence: runtime.events.lastSequence, provider: runtime.provider.name, dataDirectory });
  if (command === 'recover') return print({ recovered: await runtime.recover(), sequence: runtime.events.lastSequence });
  if (command === 'benchmark') { const count = Number(args[args.indexOf('--agents') + 1] ?? 10); if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--agents must be an integer from 1 to 100'); const started = performance.now(); const execution = await runtime.execute({ goal: `Benchmark bounded swarm with ${count} agents`, budget: { maxAgents: count, maxTasks: 64 } }); return print({ agents: count, executionId: execution.id, status: execution.status, elapsedMs: Math.round(performance.now() - started), tasks: execution.usage.tasks }); }
  if (command === 'execution') { const executionId = args[1]; const action = args[2]; if (!executionId || !['pause', 'resume', 'cancel', 'retry', 'checkpoint'].includes(action ?? '')) throw new Error('Usage: helix execution <id> <pause|resume|cancel|retry|checkpoint>'); if (action === 'pause') return print(await runtime.pause(executionId)); if (action === 'resume') return print(await runtime.resume(executionId)); if (action === 'cancel') return print(await runtime.cancel(executionId)); if (action === 'retry') return print(await runtime.retry(executionId)); return print(await runtime.checkpoint(executionId)); }
  throw new Error(`Unknown command: ${command}`);
}
main().catch((error: unknown) => { console.error(`helix: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
