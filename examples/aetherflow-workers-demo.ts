import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentScheduler } from '../packages/scheduler/src/index.js';
import { WorkerPool } from '../packages/workers/src/index.js';

const registry = new AgentRegistry(true, 100);
const scheduler = new AgentScheduler(registry, undefined, { defaultAgentCapacity: 2 });
const pool = new WorkerPool(scheduler, registry);
let completed = 0;
pool.on((event) => { if (event.type === 'worker.completed') completed++; });

for (let i = 0; i < 250; i++) scheduler.enqueue({ title: `simulation-task-${i + 1}`, requiredCapabilities: i % 2 ? ['coding'] : ['analysis'], priority: (i % 10) + 1, estimatedComplexity: (i % 5) + 1 });
await pool.drain();
console.log(JSON.stringify({ agents: registry.list().length, completed, scheduler: scheduler.metrics(), workers: pool.metrics() }, null, 2));
