import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentProfile, id, timestamp } from '../../core/src/index.js';
import { ConsensusOptions, ConsensusResult, Vote, decide } from '../../consensus/src/index.js';

export type SwarmTopology = 'hierarchical' | 'mesh' | 'pipeline' | 'centralized' | 'debate' | 'jury' | 'ensemble' | 'map-reduce' | 'supervisor-worker' | 'adaptive';
export type SwarmRole = 'supervisor' | 'leader' | 'worker' | 'critic' | 'judge' | 'member';

export interface SwarmTask<T> {
  id: string;
  input: T;
  requiredCapabilities?: string[];
}

export interface SwarmAssignment<T> {
  task: SwarmTask<T>;
  agent: AgentProfile;
  role: SwarmRole;
}

export interface SwarmPlan<T> {
  topology: SwarmTopology;
  assignments: SwarmAssignment<T>[];
  rounds: number;
  rationale: string[];
}

export interface SwarmDecision<T> {
  swarmId?: string;
  plan: SwarmPlan<T>;
  outputs: Array<{ agentId: string; value: T; evidence?: string[] }>;
  consensus?: ConsensusResult<T>;
}

export interface DurableSwarmRound {
  index: number;
  startedAt: string;
  completedAt: string;
  assignments: Array<{ taskId: string; agentId: string; role: SwarmRole }>;
  outputs: Array<{ agentId: string; value: unknown; evidence?: string[] }>;
}

export interface DurableSwarmExecution {
  id: string;
  topology: SwarmTopology;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  rationale: string[];
  rounds: DurableSwarmRound[];
  consensus?: unknown;
  error?: string;
}

export class DurableSwarmState {
  private readonly executions = new Map<string, DurableSwarmExecution>();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile: string) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.stateFile), { recursive: true });
    try {
      const persisted = JSON.parse(await readFile(this.stateFile, 'utf8')) as DurableSwarmExecution[];
      if (!Array.isArray(persisted)) throw new Error('Swarm state must be an array');
      for (const execution of persisted) this.executions.set(execution.id, structuredClone(execution));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async start<T>(plan: SwarmPlan<T>): Promise<DurableSwarmExecution> {
    await this.init();
    const now = timestamp();
    const execution: DurableSwarmExecution = {
      id: id('swarm'),
      topology: plan.topology,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      rationale: [...plan.rationale],
      rounds: [],
    };
    this.executions.set(execution.id, execution);
    await this.persist();
    return structuredClone(execution);
  }

  async recordRound<T>(swarmId: string, assignments: SwarmAssignment<T>[], outputs: Array<{ agentId: string; value: T; evidence?: string[] }>): Promise<DurableSwarmExecution> {
    await this.init();
    const execution = this.require(swarmId);
    const now = timestamp();
    execution.rounds.push({
      index: execution.rounds.length + 1,
      startedAt: now,
      completedAt: now,
      assignments: assignments.map((assignment) => ({ taskId: assignment.task.id, agentId: assignment.agent.id, role: assignment.role })),
      outputs: outputs.map((output) => ({ agentId: output.agentId, value: structuredClone(output.value), ...(output.evidence ? { evidence: [...output.evidence] } : {}) })),
    });
    execution.updatedAt = now;
    await this.persist();
    return structuredClone(execution);
  }

  async complete(swarmId: string, consensus?: unknown): Promise<DurableSwarmExecution> {
    await this.init();
    const execution = this.require(swarmId);
    execution.status = 'completed';
    execution.updatedAt = timestamp();
    if (consensus !== undefined) execution.consensus = structuredClone(consensus);
    delete execution.error;
    await this.persist();
    return structuredClone(execution);
  }

  async fail(swarmId: string, error: string): Promise<DurableSwarmExecution> {
    await this.init();
    const execution = this.require(swarmId);
    execution.status = 'failed';
    execution.error = error;
    execution.updatedAt = timestamp();
    await this.persist();
    return structuredClone(execution);
  }

  async get(swarmId: string): Promise<DurableSwarmExecution | undefined> {
    await this.init();
    const execution = this.executions.get(swarmId);
    return execution ? structuredClone(execution) : undefined;
  }

  async list(): Promise<DurableSwarmExecution[]> {
    await this.init();
    return [...this.executions.values()].map((execution) => structuredClone(execution));
  }

  private require(swarmId: string): DurableSwarmExecution {
    const execution = this.executions.get(swarmId);
    if (!execution) throw new Error(`Unknown swarm: ${swarmId}`);
    return execution;
  }

  private async persist(): Promise<void> {
    await this.enqueue(async () => {
      const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.executions.values()], null, 2), 'utf8');
      await rename(temporary, this.stateFile);
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }
}

export interface SwarmCoordinatorOptions {
  state?: DurableSwarmState;
}

export class SwarmCoordinator {
  private readonly state: DurableSwarmState | undefined;

  constructor(options: SwarmCoordinatorOptions = {}) {
    this.state = options.state;
  }

  plan<T>(tasks: SwarmTask<T>[], agents: AgentProfile[], topology: SwarmTopology = 'adaptive'): SwarmPlan<T> {
    if (!tasks.length) throw new Error('Swarm requires at least one task');
    const available = agents.filter((agent) => agent.status !== 'offline');
    if (!available.length) throw new Error('No agents available for swarm');
    const selectedTopology = topology === 'adaptive' ? this.adaptiveTopology(tasks, available) : topology;
    if (selectedTopology === 'supervisor-worker') return this.supervisorWorkerPlan(tasks, available);

    const assignments: SwarmAssignment<T>[] = [];
    tasks.forEach((task, index) => {
      const eligible = available.filter((agent) => !task.requiredCapabilities?.length || task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)));
      if (!eligible.length) throw new Error(`No agent satisfies swarm task ${task.id}`);
      const agent = eligible[index % eligible.length]!;
      const role: SwarmRole = selectedTopology === 'hierarchical' && index === 0 ? 'leader' : selectedTopology === 'debate' ? 'critic' : selectedTopology === 'jury' ? 'judge' : 'worker';
      assignments.push({ task, agent, role });
    });
    return { topology: selectedTopology, assignments, rounds: selectedTopology === 'debate' || selectedTopology === 'jury' ? 2 : 1, rationale: [`topology=${selectedTopology}`, `tasks=${tasks.length}`, `agents=${available.length}`] };
  }

  async run<T>(tasks: SwarmTask<T>[], agents: AgentProfile[], execute: (assignment: SwarmAssignment<T>) => Promise<{ value: T; evidence?: string[] }>, topology: SwarmTopology = 'adaptive', consensusOptions?: ConsensusOptions<T>): Promise<SwarmDecision<T>> {
    const plan = this.plan(tasks, agents, topology);
    const durable = this.state ? await this.state.start(plan) : undefined;
    const outputs = [] as Array<{ agentId: string; value: T; evidence?: string[] }>;
    try {
      for (const assignment of plan.assignments) {
        const result = await execute(assignment);
        outputs.push({ agentId: assignment.agent.id, value: result.value, ...(result.evidence ? { evidence: result.evidence } : {}) });
      }
      const votes: Vote<T>[] = outputs.map((output) => ({ voterId: output.agentId, value: output.value, confidence: 0.5, ...(output.evidence ? { evidence: output.evidence } : {}) }));
      const consensus = consensusOptions && votes.length ? decide(votes, consensusOptions) : undefined;
      if (durable && this.state) {
        await this.state.recordRound(durable.id, plan.assignments, outputs);
        await this.state.complete(durable.id, consensus);
      }
      return { ...(durable ? { swarmId: durable.id } : {}), plan, outputs, ...(consensus ? { consensus } : {}) };
    } catch (error) {
      if (durable && this.state) await this.state.fail(durable.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private supervisorWorkerPlan<T>(tasks: SwarmTask<T>[], agents: AgentProfile[]): SwarmPlan<T> {
    const supervisor = agents.find((agent) => agent.capabilities.includes('supervision'));
    const judge = agents.find((agent) => agent.capabilities.includes('judging'));
    if (!supervisor) throw new Error('Supervisor-worker swarm requires a supervision-capable agent');
    if (!judge) throw new Error('Supervisor-worker swarm requires a judging-capable agent');

    const workers = agents.filter((agent) => agent.id !== supervisor.id && agent.id !== judge.id);
    const assignments: SwarmAssignment<T>[] = [
      { task: { id: '__supervisor__', input: tasks[0]!.input, requiredCapabilities: ['supervision'] }, agent: supervisor, role: 'supervisor' },
    ];
    tasks.forEach((task, index) => {
      const eligible = workers.filter((agent) => !task.requiredCapabilities?.length || task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)));
      if (!eligible.length) throw new Error(`No worker satisfies swarm task ${task.id}`);
      assignments.push({ task, agent: eligible[index % eligible.length]!, role: 'worker' });
    });
    assignments.push({ task: { id: '__judge__', input: tasks[tasks.length - 1]!.input, requiredCapabilities: ['judging'] }, agent: judge, role: 'judge' });
    return {
      topology: 'supervisor-worker',
      assignments,
      rounds: 2,
      rationale: ['topology=supervisor-worker', `tasks=${tasks.length}`, `agents=${agents.length}`, `supervisor=${supervisor.name}`, `judge=${judge.name}`],
    };
  }

  private adaptiveTopology<T>(tasks: SwarmTask<T>[], agents: AgentProfile[]): SwarmTopology {
    if (tasks.length <= 1) return 'centralized';
    if (tasks.length >= agents.length * 2) return 'map-reduce';
    return tasks.length >= 3 ? 'ensemble' : 'pipeline';
  }
}
