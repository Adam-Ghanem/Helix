import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentScheduler } from '../packages/scheduler/src/index.js';

const registry = new AgentRegistry(true, 100);
const scheduler = new AgentScheduler(registry, undefined, { defaultAgentCapacity: 2, maxAssignmentsPerTick: 200 });

for (let index = 0; index < 120; index += 1) {
  scheduler.enqueue({
    title: `demo-task-${index + 1}`,
    description: 'Synthetic workload; no model or external tool call is performed.',
    requiredCapabilities: index % 3 === 0 ? ['security'] : index % 3 === 1 ? ['coding'] : ['analysis'],
    priority: (index % 10) + 1,
    urgency: index % 25 === 0 ? 'critical' : index % 10 === 0 ? 'high' : 'normal',
    estimatedComplexity: (index % 8) + 1,
  });
}

let rounds = 0;
while (scheduler.metrics().tasksWaiting > 0 && rounds < 10) {
  const assignments = scheduler.tick();
  for (const task of assignments) {
    scheduler.start(task.id);
    scheduler.complete(task.id, true);
  }
  rounds += 1;
}

console.log(JSON.stringify({
  agents: registry.list().length,
  rounds,
  metrics: scheduler.metrics(),
  sampleAssignments: scheduler.assignments().slice(0, 5),
}, null, 2));
