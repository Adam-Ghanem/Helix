import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { AgentRouter } from '../packages/scheduler/src/router.js';
import { AgentScheduler } from '../packages/scheduler/src/scheduler.js';
import { PriorityTaskQueue } from '../packages/scheduler/src/queue.js';
import { createSchedulerTask } from '../packages/scheduler/src/task.js';

function registryWith(...agents: Array<{ name: string; role: string; capabilities: string[] }>): AgentRegistry {
  const registry = new AgentRegistry(false);
  for (const agent of agents) registry.register(agent);
  return registry;
}

describe('Milestone 2 scheduler', () => {
  it('orders higher priority and urgency before background work', () => {
    const queue = new PriorityTaskQueue();
    queue.enqueue(createSchedulerTask({ title: 'background', priority: 2, urgency: 'low' }));
    queue.enqueue(createSchedulerTask({ title: 'urgent', priority: 8, urgency: 'critical' }));
    queue.enqueue(createSchedulerTask({ title: 'normal', priority: 8, urgency: 'normal' }));
    expect(queue.dequeue()?.title).toBe('urgent');
    expect(queue.dequeue()?.title).toBe('normal');
  });

  it('routes only to agents with all required capabilities', () => {
    const registry = registryWith(
      { name: 'coder', role: 'coder', capabilities: ['coding', 'typescript'] },
      { name: 'tester', role: 'tester', capabilities: ['testing'] },
    );
    const scheduler = new AgentScheduler(registry);
    const task = scheduler.enqueue({ title: 'implement', requiredCapabilities: ['coding', 'typescript'] });
    const [assignment] = scheduler.tick();
    expect(assignment?.id).toBe(task.id);
    expect(assignment?.assignedAgentId).toBe(registry.list()[0].id);
  });

  it('enforces hard capacity and prevents duplicate assignment', () => {
    const registry = registryWith({ name: 'only-coder', role: 'coder', capabilities: ['coding'] });
    const scheduler = new AgentScheduler(registry, new AgentRouter(), { defaultAgentCapacity: 1 });
    const first = scheduler.enqueue({ title: 'one', requiredCapabilities: ['coding'] });
    const second = scheduler.enqueue({ title: 'two', requiredCapabilities: ['coding'] });
    expect(scheduler.tick()).toHaveLength(1);
    expect(scheduler.tick()).toHaveLength(0);
    expect(scheduler.get(first.id).assignedAgentId).toBeDefined();
    expect(scheduler.get(second.id).status).toBe('pending');
    scheduler.complete(first.id, true);
    expect(scheduler.tick()).toHaveLength(1);
    expect(scheduler.get(second.id).assignedAgentId).toBeDefined();
  });

  it('is atomic across repeated scheduler ticks', () => {
    const registry = registryWith({ name: 'coder', role: 'coder', capabilities: ['coding'] });
    const scheduler = new AgentScheduler(registry, new AgentRouter(), { defaultAgentCapacity: 1 });
    const task = scheduler.enqueue({ title: 'single', requiredCapabilities: ['coding'] });
    expect(scheduler.tick()).toHaveLength(1);
    expect(scheduler.tick()).toHaveLength(0);
    expect(scheduler.assignments()).toHaveLength(1);
    expect(scheduler.assignments()[0].taskId).toBe(task.id);
  });

  it('prefers stronger health/reputation when capability and capacity are equal', () => {
    const registry = registryWith(
      { name: 'strong', role: 'coder', capabilities: ['coding'] },
      { name: 'weak', role: 'coder', capabilities: ['coding'] },
    );
    const [strong, weak] = registry.list();
    registry.recordOutcome(strong.id, { taskType: 'coding', domain: 'backend', success: true, quality: 1, latencyMs: 10, tokens: 10 });
    registry.recordOutcome(weak.id, { taskType: 'coding', domain: 'backend', success: false, quality: 0, latencyMs: 1000, tokens: 100 });
    const scheduler = new AgentScheduler(registry, new AgentRouter(), { defaultAgentCapacity: 1 });
    const task = scheduler.enqueue({ title: 'route', requiredCapabilities: ['coding'] });
    scheduler.tick();
    expect(scheduler.get(task.id).assignedAgentId).toBe(strong.id);
  });

  it('rebalances work away from unhealthy agents', () => {
    const registry = registryWith(
      { name: 'primary', role: 'coder', capabilities: ['coding'] },
      { name: 'backup', role: 'coder', capabilities: ['coding'] },
    );
    const scheduler = new AgentScheduler(registry, new AgentRouter(), { defaultAgentCapacity: 1 });
    const task = scheduler.enqueue({ title: 'recover', requiredCapabilities: ['coding'], maxAttempts: 3 });
    scheduler.tick();
    const assigned = scheduler.get(task.id);
    expect(assigned.status).toBe('assigned');
    registry.setStatus(assigned.assignedAgentId!, 'unhealthy');
    const requeued = scheduler.rebalance();
    expect(requeued).toHaveLength(1);
    expect(scheduler.get(task.id).status).toBe('pending');
    expect(scheduler.load.assignments()).toHaveLength(0);
  });

  it('runs a 100-agent simulation without LLM calls', () => {
    const registry = new AgentRegistry(true, 100);
    const scheduler = new AgentScheduler(registry, new AgentRouter(), { defaultAgentCapacity: 2 });
    for (let index = 0; index < 500; index += 1) {
      scheduler.enqueue({
        title: `simulation-${index}`,
        requiredCapabilities: [index % 2 === 0 ? 'coding' : 'analysis'],
        priority: (index % 10) + 1,
        urgency: index % 20 === 0 ? 'critical' : 'normal',
      });
    }
    let guard = 0;
    while (scheduler.metrics().tasksWaiting > 0 && guard < 20) {
      const assigned = scheduler.tick();
      for (const task of assigned) scheduler.complete(task.id, true);
      guard += 1;
    }
    expect(scheduler.metrics().tasksWaiting).toBe(0);
    expect(scheduler.metrics().completed).toBe(500);
  });
});
