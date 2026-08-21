import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentScheduler } from '../packages/scheduler/src/index.js';
import { WorkerPool } from '../packages/workers/src/index.js';
import { createM4Swarm } from '../packages/swarm/src/m4-index.js';

const registry = new AgentRegistry(true, 100);
const scheduler = new AgentScheduler(registry, undefined, { defaultAgentCapacity: 2 });
const pool = new WorkerPool(scheduler, registry, { workerTimeoutMs: 5_000 });
const swarm = createM4Swarm('demo-swarm', { topology: 'adaptive', maxAgents: 20, name: 'AetherFlow Demo' }, registry, scheduler, pool);
swarm.on((event) => console.log(`[${event.type}]`, event.data ?? ''));
console.log(JSON.stringify(await swarm.run('build, test, and review a TypeScript feature'), null, 2));
