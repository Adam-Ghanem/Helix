import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HelixRuntime } from '../dist/packages/runtime/src/index.js';

const directory = process.env.HELIX_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'helix-golden-'));
const runtime = new HelixRuntime({ dataDirectory: directory });
const goal = process.argv.slice(2).join(' ') || 'Analyze a software repository, identify architecture risks, review security concerns, validate safe changes, and produce a structured report';
const started = performance.now();
const execution = await runtime.execute({ goal });
const view = await runtime.view(execution.id);
console.log(JSON.stringify({ execution, tasks: view.tasks, eventCount: view.events.length, elapsedMs: Math.round(performance.now() - started), note: 'This example exercises Helix orchestration with the deterministic local provider; it does not claim to modify an external repository or connect an LLM.' }, null, 2));
if (!process.env.HELIX_DATA_DIR) await rm(directory, { recursive: true, force: true });
