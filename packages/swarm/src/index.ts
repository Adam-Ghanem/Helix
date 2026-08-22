import { AgentProfile } from '../../core/src/index.js';
import { ConsensusOptions, ConsensusResult, Vote, decide } from '../../consensus/src/index.js';

export type SwarmTopology = 'hierarchical' | 'mesh' | 'pipeline' | 'centralized' | 'debate' | 'jury' | 'ensemble' | 'map-reduce' | 'supervisor-worker' | 'adaptive';

export interface SwarmTask<T> {
  id: string;
  input: T;
  requiredCapabilities?: string[];
}

export interface SwarmAssignment<T> {
  task: SwarmTask<T>;
  agent: AgentProfile;
  role: 'leader' | 'worker' | 'critic' | 'judge' | 'member';
}

export interface SwarmPlan<T> {
  topology: SwarmTopology;
  assignments: SwarmAssignment<T>[];
  rounds: number;
  rationale: string[];
}

export interface SwarmDecision<T> {
  plan: SwarmPlan<T>;
  outputs: Array<{ agentId: string; value: T; evidence?: string[] }>;
  consensus?: ConsensusResult<T>;
}

export class SwarmCoordinator {
  plan<T>(tasks: SwarmTask<T>[], agents: AgentProfile[], topology: SwarmTopology = 'adaptive'): SwarmPlan<T> {
    const available = agents.filter((agent) => agent.status !== 'offline');
    if (!available.length) throw new Error('No agents available for swarm');
    const selectedTopology = topology === 'adaptive' ? this.adaptiveTopology(tasks, available) : topology;
    const assignments: SwarmAssignment<T>[] = [];
    tasks.forEach((task, index) => {
      const eligible = available.filter((agent) => !task.requiredCapabilities?.length || task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)));
      if (!eligible.length) throw new Error(`No agent satisfies swarm task ${task.id}`);
      const agent = eligible[index % eligible.length]!;
      const role = selectedTopology === 'hierarchical' && index === 0 ? 'leader' : selectedTopology === 'debate' ? 'critic' : selectedTopology === 'jury' ? 'judge' : 'worker';
      assignments.push({ task, agent, role });
    });
    return { topology: selectedTopology, assignments, rounds: selectedTopology === 'debate' || selectedTopology === 'jury' ? 2 : 1, rationale: [`topology=${selectedTopology}`, `tasks=${tasks.length}`, `agents=${available.length}`] };
  }

  async run<T>(tasks: SwarmTask<T>[], agents: AgentProfile[], execute: (assignment: SwarmAssignment<T>) => Promise<{ value: T; evidence?: string[] }>, topology: SwarmTopology = 'adaptive', consensusOptions?: ConsensusOptions<T>): Promise<SwarmDecision<T>> {
    const plan = this.plan(tasks, agents, topology);
    const outputs = [] as Array<{ agentId: string; value: T; evidence?: string[] }>;
    for (const assignment of plan.assignments) {
      const result = await execute(assignment);
      outputs.push({ agentId: assignment.agent.id, value: result.value, ...(result.evidence ? { evidence: result.evidence } : {}) });
    }
    const votes: Vote<T>[] = outputs.map((output) => ({ voterId: output.agentId, value: output.value, confidence: 0.5, ...(output.evidence ? { evidence: output.evidence } : {}) }));
    const consensus = consensusOptions && votes.length ? decide(votes, consensusOptions) : undefined;
    return { plan, outputs, ...(consensus ? { consensus } : {}) };
  }

  private adaptiveTopology<T>(tasks: SwarmTask<T>[], agents: AgentProfile[]): SwarmTopology {
    if (tasks.length <= 1) return 'centralized';
    if (tasks.length >= agents.length * 2) return 'map-reduce';
    return tasks.length >= 3 ? 'ensemble' : 'pipeline';
  }
}

export * from './autonomous.js';
