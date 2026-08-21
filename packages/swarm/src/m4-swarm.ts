import type { AgentRegistry } from '../../agents/src/index.js';
import type { AgentScheduler } from '../../scheduler/src/index.js';
import type { WorkerPool } from '../../workers/src/index.js';
import { chooseAdaptiveTopology, planHierarchical, planMesh } from './m4-topology.js';
import type { M4SwarmAssignment, M4SwarmConfig, M4SwarmEvent, M4SwarmMetrics, M4SwarmStatus, M4SwarmTask, M4SwarmTopology } from './m4-types.js';

export class M4Swarm {
  private topology: Exclude<M4SwarmTopology, 'adaptive'>;
  private state: M4SwarmStatus = 'idle';
  private readonly tasks = new Map<string, M4SwarmTask>();
  private assignments: M4SwarmAssignment[] = [];
  private completed = 0;
  private failed = 0;
  private topologyChanges = 0;
  private listeners = new Set<(event: M4SwarmEvent) => void>();
  readonly members;
  constructor(readonly id: string, readonly config: M4SwarmConfig, private readonly registry: AgentRegistry, private readonly scheduler: AgentScheduler, private readonly pool: WorkerPool) {
    this.topology = config.topology === 'adaptive' ? 'hierarchical' : config.topology;
    const required = new Set(config.requiredCapabilities ?? []);
    this.members = registry.list().filter((agent) => [...required].every((capability) => agent.capabilities.includes(capability))).slice(0, config.maxAgents);
    if (!this.members.length) throw new Error('Swarm has no eligible members');
    this.emit({ type: 'swarm.created', timestamp: new Date().toISOString(), data: { topology: this.topology, agents: this.members.length } });
  }
  on(listener: (event: M4SwarmEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  submit(goal: string): M4SwarmTask[] { const tasks = this.decompose(goal); tasks.forEach((task) => this.tasks.set(task.id, task)); this.replan(tasks); for (const assignment of this.assignments) { const task = assignment.task; this.scheduler.enqueue({ id: `${this.id}:${task.id}`, title: task.title, description: task.description, requiredCapabilities: task.requiredCapabilities, priority: task.priority ?? 5, urgency: 'normal', estimatedComplexity: 4, maxAttempts: 2 }); this.emit({ type: 'swarm.task.submitted', timestamp: new Date().toISOString(), taskId: task.id, data: { agentId: assignment.agentId, topology: this.topology } }); } this.state = 'running'; return tasks; }
  async run(goal: string): Promise<M4SwarmMetrics> { this.submit(goal); await this.pool.drain(); const results = this.scheduler.listTasks().filter((task) => task.id.startsWith(`${this.id}:`)); this.completed = results.filter((task) => task.status === 'completed').length; this.failed = results.filter((task) => task.status === 'failed').length; this.state = this.failed ? 'failed' : 'completed'; this.emit({ type: 'swarm.completed', timestamp: new Date().toISOString(), data: { completed: this.completed, failed: this.failed } }); return this.metrics(); }
  status(): M4SwarmStatus { return this.state; }
  metrics(): M4SwarmMetrics { return { status: this.state, topology: this.topology, agents: this.members.length, tasks: this.tasks.size, completed: this.completed, failed: this.failed, active: this.scheduler.assignments().filter((a) => this.members.some((agent) => agent.id === a.agentId)).length, topologyChanges: this.topologyChanges }; }
  stop(): void { this.state = 'stopped'; for (const task of this.scheduler.listTasks()) if (task.id.startsWith(`${this.id}:`) && ['pending', 'assigned', 'running'].includes(task.status)) this.scheduler.cancel(task.id); }
  private replan(tasks: M4SwarmTask[]): void { if (this.config.topology === 'adaptive') { const metrics = this.scheduler.metrics(); const next = chooseAdaptiveTopology(this.topology, { failureRate: metrics.failed / Math.max(metrics.completed + metrics.failed, 1), queueWaitMs: metrics.averageWaitMs, parallel: tasks.length > 1 }, { failureRateThreshold: this.config.failureRateThreshold ?? 0.25, queueWaitThresholdMs: this.config.queueWaitThresholdMs ?? 1_000 }); if (next !== this.topology) { this.topology = next; this.topologyChanges++; this.emit({ type: 'topology.changed', timestamp: new Date().toISOString(), data: { topology: next } }); } } this.assignments = this.topology === 'mesh' ? planMesh(tasks, this.members, this.config.maxAgents) : planHierarchical(tasks, this.members, this.config.maxAgents); }
  private decompose(goal: string): M4SwarmTask[] { const text = goal.toLowerCase(); const tasks: M4SwarmTask[] = []; const add = (title: string, description: string, capabilities: string[], priority: number) => tasks.push({ id: `${this.id}-task-${tasks.length + 1}`, title, description: `${description}: ${goal}`, requiredCapabilities: capabilities, priority }); add('Plan', 'Create an execution plan', ['planning'], 9); if (/code|implement|build|feature|fix/.test(text)) add('Implement', 'Implement the requested change', ['coding'], 8); if (/test|quality|code|implement|fix/.test(text)) add('Test', 'Validate the implementation', ['testing'], 7); add('Review', 'Review the result for correctness and quality', ['review'], 6); return tasks; }
  private emit(event: M4SwarmEvent): void { for (const listener of this.listeners) listener(event); }
}
export function createM4Swarm(id: string, config: M4SwarmConfig, registry: AgentRegistry, scheduler: AgentScheduler, pool: WorkerPool): M4Swarm { return new M4Swarm(id, config, registry, scheduler, pool); }
