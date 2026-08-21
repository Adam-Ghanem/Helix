import { id, timestamp, type AgentId, type AgentProfile } from '../../core/src/index.js';
import type { AgentRegistry } from '../../agents/src/index.js';
import type { AgentRouter, RoutingCandidate, RoutingDecision } from '../../router/src/index.js';
import type { Lease, LeaseScheduler } from '../../scheduler/src/index.js';
import { decide, type ConsensusStrategy, type Vote } from '../../consensus/src/index.js';
import type { MemoryBackend, MemoryEntry } from '../../memory/src/index.js';

export type SwarmState = 'CREATED' | 'FORMING' | 'READY' | 'RUNNING' | 'REBALANCING' | 'PAUSED' | 'COMPLETING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type SwarmRole = 'COORDINATOR' | 'PLANNER' | 'RESEARCHER' | 'IMPLEMENTER' | 'TESTER' | 'REVIEWER' | 'SECURITY' | 'PERFORMANCE' | 'MEMORY' | 'OBSERVER';
export type DynamicSwarmTopology = 'hierarchical' | 'mesh' | 'adaptive' | 'pipeline' | 'parallel' | 'consensus' | 'hybrid';
export type SwarmMemberStatus = 'active' | 'idle' | 'paused' | 'overloaded' | 'unhealthy' | 'offline' | 'left';
export type DelegationMode = 'direct' | 'capability' | 'role' | 'swarm';

export interface SwarmMember {
  agentId: AgentId;
  role: SwarmRole;
  roles: SwarmRole[];
  capabilities: string[];
  status: SwarmMemberStatus;
  currentTasks: string[];
  health: AgentProfile['health'];
  reputation: number;
  contribution: number;
  joinedAt: string;
  lastActivityAt: string;
}

export interface Swarm {
  id: string;
  name: string;
  goalId: string;
  topology: DynamicSwarmTopology;
  coordinatorId?: AgentId;
  members: SwarmMember[];
  state: SwarmState;
  strategy: 'adaptive' | 'capability' | 'quality' | 'latency' | 'hybrid';
  maxAgents: number;
  minAgents: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicSwarmTask {
  id: string;
  title: string;
  requiredCapabilities: string[];
  dependencies: string[];
  role?: SwarmRole;
  parallelizable?: boolean;
  risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface SwarmFormationResult {
  swarm: Swarm;
  assignments: DelegationRecord[];
  rationale: string[];
}

export interface DelegationRecord {
  id: string;
  swarmId: string;
  taskId: string;
  agentId: AgentId;
  mode: DelegationMode;
  role?: SwarmRole;
  capabilities: string[];
  leaseId?: string;
  status: 'assigned' | 'completed' | 'failed' | 'handed-off' | 'released';
  assignedAt: string;
  completedAt?: string;
}

export interface HandoffRecord {
  id: string;
  swarmId: string;
  taskId: string;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  reason: string;
  sequence: number;
  createdAt: string;
}

export interface CollaborationNode { id: string; type: 'agent' | 'task'; label: string; }
export interface CollaborationEdge { from: string; to: string; type: 'delegation' | 'handoff' | 'dependency' | 'rebalance'; taskId?: string; createdAt: string; }
export interface CollaborationGraph { nodes: CollaborationNode[]; edges: CollaborationEdge[]; }

export interface SwarmHealthSnapshot {
  swarmId: string;
  activeAgents: number;
  idleAgents: number;
  overloadedAgents: number;
  unhealthyAgents: number;
  activeTasks: number;
  failedTasks: number;
  timedOutTasks: number;
  queueWaitMs: number;
  utilization: number;
  failureRate: number;
  handoffs: number;
  stalls: number;
  securityDenials: number;
  observedAt: string;
}

export interface ScaleDecision { changed: boolean; direction: 'up' | 'down' | 'none'; added: AgentId[]; removed: AgentId[]; reason: string; }
export interface RebalanceResult { changed: boolean; movedTaskIds: string[]; fromAgentIds: AgentId[]; toAgentIds: AgentId[]; reason: string; }
export interface TopologyDecision { previous: DynamicSwarmTopology; next: DynamicSwarmTopology; reasons: string[]; changed: boolean; }

export interface SwarmVote<T> { agentId: AgentId; value: T; confidence: number; evidence?: string[]; capabilities?: string[]; }
export interface SwarmConsensusResult<T> { decision?: T; votes: SwarmVote<T>[]; confidence: number; dissent: AgentId[]; reached: boolean; strategy: 'MAJORITY' | 'UNANIMOUS' | 'WEIGHTED'; rationale: string[]; }

export interface SwarmResult<T = unknown> {
  success: boolean;
  score: number;
  summary: string;
  completedTasks: string[];
  failedTasks: string[];
  decisions: string[];
  warnings: string[];
  provenance: Array<{ taskId: string; agentId?: AgentId; source: string }>;
  outputs: Array<{ taskId: string; agentId?: AgentId; value: T }>;
}

export interface SwarmEvent { type: string; swarmId: string; payload: Record<string, unknown>; }
export interface DynamicSwarmOptions {
  agents: AgentRegistry;
  router: AgentRouter;
  scheduler: LeaseScheduler;
  memory?: MemoryBackend;
  eventSink?: (event: SwarmEvent) => Promise<void>;
  subject?: string;
  minAgents?: number;
  maxAgents?: number;
  maxHandoffs?: number;
  queueWaitThresholdMs?: number;
  failureRateThreshold?: number;
}

function clone<T>(value: T): T { return structuredClone(value); }
function now(): string { return timestamp(); }
function capabilitiesMatch(agent: AgentProfile, required: string[]): boolean { return required.every((capability) => agent.capabilities.includes(capability)); }
function roleForTask(task: DynamicSwarmTask): SwarmRole {
  if (task.role) return task.role;
  if (task.requiredCapabilities.includes('security') || task.requiredCapabilities.includes('threat-modeling')) return 'SECURITY';
  if (task.requiredCapabilities.includes('testing') || task.requiredCapabilities.includes('quality')) return 'TESTER';
  if (task.requiredCapabilities.includes('research')) return 'RESEARCHER';
  if (task.requiredCapabilities.includes('coding') || task.requiredCapabilities.includes('backend') || task.requiredCapabilities.includes('frontend')) return 'IMPLEMENTER';
  if (task.requiredCapabilities.includes('performance')) return 'PERFORMANCE';
  if (task.requiredCapabilities.includes('documentation') || task.requiredCapabilities.includes('writing') || task.requiredCapabilities.includes('review') || task.requiredCapabilities.includes('quality')) return 'REVIEWER';
  return 'OBSERVER';
}
function memberStatus(agent: AgentProfile, taskCount: number): SwarmMemberStatus { if (agent.status === 'offline') return 'offline'; if (agent.status === 'unhealthy') return 'unhealthy'; if (taskCount >= 3) return 'overloaded'; if (agent.status === 'busy' || taskCount > 0) return 'active'; return 'idle'; }

export class DynamicSwarmManager {
  private readonly swarms = new Map<string, Swarm>();
  private readonly tasks = new Map<string, DynamicSwarmTask>();
  private readonly delegations = new Map<string, DelegationRecord>();
  private readonly handoffs = new Map<string, HandoffRecord[]>();
  private readonly graphNodes = new Map<string, CollaborationNode>();
  private readonly graphEdges: CollaborationEdge[] = [];
  private readonly failures = new Map<string, { failed: number; timeouts: number }>();
  private readonly opts: Required<Pick<DynamicSwarmOptions, 'maxHandoffs' | 'queueWaitThresholdMs' | 'failureRateThreshold'>> & DynamicSwarmOptions;

  constructor(options: DynamicSwarmOptions) {
    this.opts = { ...options, maxHandoffs: options.maxHandoffs ?? 3, queueWaitThresholdMs: options.queueWaitThresholdMs ?? 5_000, failureRateThreshold: options.failureRateThreshold ?? 0.25 };
  }

  async create(input: { name: string; goalId: string; topology?: DynamicSwarmTopology; strategy?: Swarm['strategy']; minAgents?: number; maxAgents?: number; risk?: Swarm['risk']; approvedBy?: string }): Promise<Swarm> {
    const capacity = this.opts.agents.list().length;
    const maxAgents = Math.max(1, Math.min(input.maxAgents ?? this.opts.maxAgents ?? capacity, capacity));
    const minAgents = Math.max(0, Math.min(input.minAgents ?? this.opts.minAgents ?? 1, maxAgents));
    const swarm: Swarm = { id: id('swarm'), name: input.name.trim() || 'helix-swarm', goalId: input.goalId, topology: input.topology ?? 'adaptive', members: [], state: 'CREATED', strategy: input.strategy ?? 'adaptive', maxAgents, minAgents, risk: input.risk ?? 'LOW', ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}), createdAt: now(), updatedAt: now() };
    this.swarms.set(swarm.id, swarm);
    await this.emit('swarm.created', swarm.id, { swarm: clone(swarm) });
    return clone(swarm);
  }

  get(swarmId: string): Swarm { return clone(this.requireSwarm(swarmId)); }
  list(): Swarm[] { return [...this.swarms.values()].map((swarm) => clone(swarm)); }
  async transition(swarmId: string, next: SwarmState): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); const allowed: Record<SwarmState, SwarmState[]> = { CREATED: ['FORMING', 'READY', 'CANCELLED'], FORMING: ['READY', 'FAILED', 'CANCELLED'], READY: ['RUNNING', 'REBALANCING', 'PAUSED', 'CANCELLED'], RUNNING: ['REBALANCING', 'PAUSED', 'COMPLETING', 'FAILED', 'CANCELLED'], REBALANCING: ['RUNNING', 'READY', 'FAILED', 'CANCELLED'], PAUSED: ['READY', 'RUNNING', 'CANCELLED'], COMPLETING: ['COMPLETED', 'FAILED'], COMPLETED: [], FAILED: [], CANCELLED: [] }; const previous = swarm.state; if (!allowed[previous].includes(next)) throw new Error(`invalid swarm transition ${previous} -> ${next}`); swarm.state = next; swarm.updatedAt = now(); await this.emit(`swarm.state.${next.toLowerCase()}`, swarmId, { previous, state: next }); return clone(swarm); }
  async cancel(swarmId: string): Promise<Swarm> { return this.transition(swarmId, 'CANCELLED'); }
  async pause(swarmId: string): Promise<Swarm> { return this.transition(swarmId, 'PAUSED'); }
  async start(swarmId: string): Promise<Swarm> { return this.transition(swarmId, 'RUNNING'); }
  async complete(swarmId: string): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); if (swarm.state !== 'COMPLETING') await this.transition(swarmId, 'COMPLETING'); return this.transition(swarmId, 'COMPLETED'); }
  async fail(swarmId: string, reason = 'swarm failure'): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); if (swarm.state !== 'FAILED') { if (!['CREATED', 'FORMING', 'READY', 'RUNNING', 'REBALANCING'].includes(swarm.state)) throw new Error(`swarm ${swarmId} cannot fail from state ${swarm.state}`); await this.transition(swarmId, 'FAILED'); } await this.emit('swarm.failed', swarmId, { reason }); return clone(this.requireSwarm(swarmId)); }

  async form(swarmId: string, tasks: DynamicSwarmTask[]): Promise<SwarmFormationResult> {
    const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm);
    if (swarm.state !== 'CREATED' && swarm.state !== 'READY') throw new Error(`swarm ${swarmId} cannot form from state ${swarm.state}`);
    if (!tasks.length) throw new Error('swarm formation requires at least one task');
    if (tasks.length > swarm.maxAgents * 16) throw new Error('swarm formation exceeds bounded task fan-out');
    swarm.state = 'FORMING'; swarm.updatedAt = now();
    const ordered = [...tasks].sort((left, right) => left.dependencies.length - right.dependencies.length || left.id.localeCompare(right.id));
    for (const task of ordered) { this.tasks.set(task.id, clone(task)); this.addGraphNode({ id: `task:${task.id}`, type: 'task', label: task.title }); for (const dependency of task.dependencies) this.addGraphEdge({ from: `task:${dependency}`, to: `task:${task.id}`, type: 'dependency', taskId: task.id, createdAt: now() }); }
    const topology = this.chooseTopology(swarm, ordered);
    swarm.topology = topology.next;
    const assignments: DelegationRecord[] = [];
    for (const task of ordered) {
      let existing = swarm.members.filter((member) => member.status !== 'left' && member.status !== 'offline');
      let candidates = this.routingCandidates(existing, task.requiredCapabilities);
      if (!candidates.length) {
        const provisionable = this.opts.agents.list().filter((agent) => agent.status !== 'offline' && agent.status !== 'unhealthy' && capabilitiesMatch(agent, task.requiredCapabilities) && !existing.some((member) => member.agentId === agent.id)).sort((left, right) => right.health.qualityScore - left.health.qualityScore || left.id.localeCompare(right.id));
        const agent = provisionable[0];
        if (agent) { await this.addAgent(swarmId, agent.id, [roleForTask(task)]); existing = swarm.members.filter((member) => member.status !== 'left' && member.status !== 'offline'); candidates = this.routingCandidates(existing, task.requiredCapabilities); }
      }
      const decision = this.route(task, candidates, swarm.strategy);
      const assignment = await this.assign(swarm, task, decision.agentId, 'capability', roleForTask(task), false);
      assignments.push(assignment);
    }
    if (swarm.members.length < swarm.minAgents) await this.scale(swarm.id, swarm.minAgents);
    const coordinator = this.chooseCoordinator(swarm);
    if (coordinator) swarm.coordinatorId = coordinator.agentId;
    swarm.state = 'READY'; swarm.updatedAt = now();
    await this.emit('swarm.formed', swarm.id, { memberCount: swarm.members.length, taskCount: ordered.length, topology: swarm.topology, coordinatorId: swarm.coordinatorId ?? null });
    await this.learn(swarm, 'successful-team', `team=${swarm.members.map((member) => member.agentId).join(',')}`);
    return { swarm: clone(swarm), assignments: clone(assignments), rationale: [`topology=${swarm.topology}`, `members=${swarm.members.length}`, `tasks=${ordered.length}`, 'capability matching occurred before routing score'] };
  }

  async addAgent(swarmId: string, agentId: AgentId, roles: SwarmRole[] = ['OBSERVER']): Promise<SwarmMember> {
    const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm); const agent = this.opts.agents.get(agentId);
    if (swarm.members.some((member) => member.agentId === agentId && member.status !== 'left')) throw new Error(`agent ${agentId} is already a swarm member`);
    if (swarm.members.filter((member) => member.status !== 'left').length >= swarm.maxAgents) throw new Error(`swarm ${swarmId} reached maxAgents=${swarm.maxAgents}`);
    const normalizedRoles = [...new Set(roles)]; const member: SwarmMember = { agentId, role: normalizedRoles[0] ?? 'OBSERVER', roles: normalizedRoles, capabilities: [...agent.capabilities], status: memberStatus(agent, 0), currentTasks: [], health: clone(agent.health), reputation: agent.health.qualityScore, contribution: 0, joinedAt: now(), lastActivityAt: now() };
    swarm.members = [...swarm.members.filter((candidate) => candidate.agentId !== agentId), member]; swarm.updatedAt = now(); this.addGraphNode({ id: `agent:${agentId}`, type: 'agent', label: agent.name });
    await this.emit('swarm.agent.added', swarmId, { agentId, roles: normalizedRoles });
    return clone(member);
  }

  async removeAgent(swarmId: string, agentId: AgentId, force = false): Promise<Swarm> {
    const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm); const member = this.requireMember(swarm, agentId);
    if (!force && member.currentTasks.length) throw new Error(`agent ${agentId} has active tasks`);
    if (swarm.members.filter((candidate) => candidate.status !== 'left').length <= swarm.minAgents) throw new Error(`swarm ${swarmId} cannot go below minAgents=${swarm.minAgents}`);
    member.status = 'left'; member.currentTasks = []; if (swarm.coordinatorId === agentId) { const next = this.chooseCoordinator(swarm, agentId); if (next) swarm.coordinatorId = next.agentId; else delete swarm.coordinatorId; } swarm.updatedAt = now();
    await this.emit('swarm.agent.removed', swarmId, { agentId, force });
    return clone(swarm);
  }

  async replaceAgent(swarmId: string, oldAgentId: AgentId, newAgentId: AgentId): Promise<Swarm> {
    const swarm = this.requireSwarm(swarmId); const oldMember = this.requireMember(swarm, oldAgentId); const tasks = [...oldMember.currentTasks]; const roles = [...oldMember.roles];
    await this.addAgent(swarmId, newAgentId, roles); for (const taskId of tasks) await this.transferTask(swarm, taskId, oldAgentId, newAgentId, 'overloaded-agent replacement'); await this.removeAgent(swarmId, oldAgentId, true); await this.emit('swarm.agent.replaced', swarmId, { oldAgentId, newAgentId, taskCount: tasks.length }); return clone(swarm);
  }

  async promoteCoordinator(swarmId: string, agentId: AgentId): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); const member = this.requireMember(swarm, agentId); if (member.status === 'offline' || member.status === 'unhealthy') throw new Error('unhealthy or offline agent cannot coordinate'); if (swarm.coordinatorId) { const previous = swarm.members.find((candidate) => candidate.agentId === swarm.coordinatorId); if (previous) { previous.roles = previous.roles.filter((role) => role !== 'COORDINATOR'); previous.role = previous.roles[0] ?? 'OBSERVER'; } } if (!member.roles.includes('COORDINATOR')) member.roles = ['COORDINATOR', ...member.roles]; member.role = 'COORDINATOR'; swarm.coordinatorId = agentId; swarm.updatedAt = now(); await this.emit('swarm.coordinator.promoted', swarmId, { agentId }); return clone(swarm); }
  async demoteCoordinator(swarmId: string, agentId: AgentId): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); const member = this.requireMember(swarm, agentId); if (swarm.coordinatorId !== agentId) throw new Error(`agent ${agentId} is not coordinator`); member.roles = member.roles.filter((role) => role !== 'COORDINATOR'); member.role = member.roles[0] ?? 'OBSERVER'; const next = this.chooseCoordinator(swarm, agentId); if (next) swarm.coordinatorId = next.agentId; else delete swarm.coordinatorId; swarm.updatedAt = now(); await this.emit('swarm.coordinator.demoted', swarmId, { agentId, nextCoordinatorId: swarm.coordinatorId ?? null }); return clone(swarm); }
  async pauseMember(swarmId: string, agentId: AgentId): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); const member = this.requireMember(swarm, agentId); member.status = 'paused'; member.lastActivityAt = now(); swarm.updatedAt = now(); await this.emit('swarm.agent.paused', swarmId, { agentId }); return clone(swarm); }
  async resumeMember(swarmId: string, agentId: AgentId): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); const member = this.requireMember(swarm, agentId); if (member.status === 'offline' || member.status === 'unhealthy') throw new Error(`agent ${agentId} cannot resume while ${member.status}`); member.status = member.currentTasks.length ? 'active' : 'idle'; member.lastActivityAt = now(); swarm.updatedAt = now(); await this.emit('swarm.agent.resumed', swarmId, { agentId }); return clone(swarm); }

  async delegate(swarmId: string, task: DynamicSwarmTask, target: AgentId | SwarmRole | 'swarm'): Promise<DelegationRecord> {
    const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm); this.tasks.set(task.id, clone(task)); this.addGraphNode({ id: `task:${task.id}`, type: 'task', label: task.title }); for (const dependency of task.dependencies) { this.addGraphNode({ id: `task:${dependency}`, type: 'task', label: dependency }); this.addGraphEdge({ from: `task:${dependency}`, to: `task:${task.id}`, type: 'dependency', taskId: task.id, createdAt: now() }); }
    const mode: DelegationMode = target === 'swarm' ? 'swarm' : typeof target === 'string' && target.toUpperCase() in roleValues ? 'role' : 'direct';
    const candidates = this.routingCandidates(swarm.members, task.requiredCapabilities);
    let agentId: AgentId;
    let role: SwarmRole | undefined;
    if (mode === 'direct') { agentId = target as AgentId; const agent = this.opts.agents.get(agentId); if (!capabilitiesMatch(agent, task.requiredCapabilities)) throw new Error(`agent ${agentId} does not satisfy task capabilities`); }
    else if (mode === 'role') { role = target as SwarmRole; const member = swarm.members.filter((candidate) => candidate.roles.includes(role!) && candidate.status !== 'paused' && candidate.status !== 'offline').sort((left, right) => left.currentTasks.length - right.currentTasks.length || right.reputation - left.reputation || left.agentId.localeCompare(right.agentId)).find((candidate) => capabilitiesMatch(this.opts.agents.get(candidate.agentId), task.requiredCapabilities)); if (!member) throw new Error(`no swarm member with role ${role} satisfies task capabilities`); agentId = member.agentId; }
    else { const decision = this.route(task, candidates, swarm.strategy); agentId = decision.agentId; role = roleForTask(task); }
    return this.assign(swarm, task, agentId, mode, role);
  }

  async completeDelegation(swarmId: string, delegationId: string, success = true): Promise<DelegationRecord> { const swarm = this.requireSwarm(swarmId); const delegation = this.delegations.get(delegationId); if (!delegation || delegation.swarmId !== swarmId) throw new Error(`unknown delegation ${delegationId}`); if (delegation.leaseId) this.opts.scheduler.release(delegation.leaseId); const member = this.requireMember(swarm, delegation.agentId); member.currentTasks = member.currentTasks.filter((taskId) => taskId !== delegation.taskId); member.status = member.currentTasks.length ? 'active' : 'idle'; member.contribution += success ? 1 : 0; member.lastActivityAt = now(); delegation.status = success ? 'completed' : 'failed'; delegation.completedAt = now(); swarm.updatedAt = now(); await this.emit('swarm.task.completed', swarmId, { delegationId, taskId: delegation.taskId, agentId: delegation.agentId, success }); return clone(delegation); }

  async handoff(swarmId: string, taskId: string, fromAgentId: AgentId, toAgentId: AgentId, reason: string): Promise<{ delegation: DelegationRecord; handoff: HandoffRecord }> {
    const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm); const history = this.handoffs.get(taskId) ?? []; if (history.length >= this.opts.maxHandoffs) throw new Error(`maxHandoffs=${this.opts.maxHandoffs} exceeded for task ${taskId}`); if (fromAgentId === toAgentId || history.some((entry) => entry.fromAgentId === toAgentId && entry.toAgentId === fromAgentId) || history.some((entry) => entry.toAgentId === toAgentId)) throw new Error(`handoff loop detected for task ${taskId}`);
    const task = this.tasks.get(taskId); if (!task) throw new Error(`unknown task ${taskId}`); const old = [...this.delegations.values()].reverse().find((delegation) => delegation.swarmId === swarmId && delegation.taskId === taskId && delegation.agentId === fromAgentId && delegation.status === 'assigned'); if (old?.leaseId) this.opts.scheduler.release(old.leaseId); if (old) { old.status = 'handed-off'; old.completedAt = now(); const oldMember = this.requireMember(swarm, fromAgentId); oldMember.currentTasks = oldMember.currentTasks.filter((candidate) => candidate !== taskId); oldMember.status = oldMember.currentTasks.length ? 'active' : 'idle'; }
    const delegation = await this.assign(swarm, task, toAgentId, 'direct', roleForTask(task)); const handoff: HandoffRecord = { id: id('handoff'), swarmId, taskId, fromAgentId, toAgentId, reason: reason.trim() || 'handoff requested', sequence: history.length + 1, createdAt: now() }; history.push(handoff); this.handoffs.set(taskId, history); this.addGraphEdge({ from: `agent:${fromAgentId}`, to: `agent:${toAgentId}`, type: 'handoff', taskId, createdAt: now() }); await this.emit('swarm.task.handed_off', swarmId, { handoff: clone(handoff), delegationId: delegation.id }); await this.learn(swarm, 'handoff', `task=${taskId};from=${fromAgentId};to=${toAgentId}`); return { delegation: clone(delegation), handoff: clone(handoff) };
  }

  async scale(swarmId: string, target: number): Promise<ScaleDecision> {
    const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm); if (!Number.isInteger(target) || target < swarm.minAgents || target > swarm.maxAgents) throw new Error(`target agent count must be between ${swarm.minAgents} and ${swarm.maxAgents}`); const active = swarm.members.filter((member) => member.status !== 'left'); if (target === active.length) return { changed: false, direction: 'none', added: [], removed: [], reason: 'target already satisfied' };
    const added: AgentId[] = []; const removed: AgentId[] = []; if (target > active.length) { const available = this.opts.agents.list().filter((agent) => !active.some((member) => member.agentId === agent.id) && agent.status !== 'offline' && agent.status !== 'unhealthy').sort((left, right) => left.health.qualityScore - right.health.qualityScore || left.id.localeCompare(right.id)); for (const agent of available.slice(0, target - active.length)) { await this.addAgent(swarmId, agent.id); added.push(agent.id); } if (added.length < target - active.length) throw new Error('registry capacity cannot satisfy swarm scale-up'); }
    else { const removable = active.filter((member) => member.agentId !== swarm.coordinatorId && !member.currentTasks.length).sort((left, right) => left.reputation - right.reputation || left.agentId.localeCompare(right.agentId)); for (const member of removable.slice(0, active.length - target)) { await this.removeAgent(swarmId, member.agentId); removed.push(member.agentId); } if (removed.length < active.length - target) throw new Error('no idle non-coordinator members available for scale-down'); }
    swarm.updatedAt = now(); const direction = added.length ? 'up' : 'down'; await this.emit(direction === 'up' ? 'swarm.scaled.up' : 'swarm.scaled.down', swarmId, { target, added, removed }); return { changed: true, direction, added, removed, reason: direction === 'up' ? 'parallel work or load threshold requested more capacity' : 'idle capacity was safely collapsed' };
  }

  async switchTopology(swarmId: string, topology: DynamicSwarmTopology, reason = 'explicit topology decision'): Promise<TopologyDecision> { const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm); const previous = swarm.topology; const changed = previous !== topology; swarm.topology = topology; swarm.updatedAt = now(); if (changed) { await this.emit('swarm.topology.changed', swarmId, { previous, next: topology, reason }); await this.learn(swarm, 'topology', `previous=${previous};next=${topology};reason=${reason}`); } return { previous, next: topology, reasons: [reason], changed }; }

  async rebalance(swarmId: string, reason = 'health monitor threshold'): Promise<RebalanceResult> {
    const swarm = this.requireSwarm(swarmId); this.assertAuthorized(swarm); const previous = swarm.state; if (previous !== 'REBALANCING') swarm.state = 'REBALANCING'; await this.emit('swarm.rebalance.started', swarmId, { reason }); const movedTaskIds: string[] = []; const fromAgentIds: AgentId[] = []; const toAgentIds: AgentId[] = [];
    const overloaded = swarm.members.filter((member) => member.currentTasks.length > 1 || member.status === 'overloaded').sort((left, right) => right.currentTasks.length - left.currentTasks.length || left.agentId.localeCompare(right.agentId)); for (const source of overloaded) { const taskId = source.currentTasks[0]; if (!taskId) continue; const task = this.tasks.get(taskId); if (!task) continue; const target = swarm.members.filter((member) => member.agentId !== source.agentId && ['idle', 'active'].includes(member.status) && member.currentTasks.length === 0 && capabilitiesMatch(this.opts.agents.get(member.agentId), task.requiredCapabilities)).sort((left, right) => right.reputation - left.reputation || left.agentId.localeCompare(right.agentId))[0]; if (!target) continue; await this.transferTask(swarm, taskId, source.agentId, target.agentId, 'deterministic load rebalancing'); movedTaskIds.push(taskId); fromAgentIds.push(source.agentId); toAgentIds.push(target.agentId); }
    swarm.state = previous === 'PAUSED' ? 'PAUSED' : 'READY'; swarm.updatedAt = now(); await this.emit('swarm.rebalance.completed', swarmId, { movedTaskIds, fromAgentIds, toAgentIds, reason }); if (movedTaskIds.length) await this.learn(swarm, 'rebalance', `tasks=${movedTaskIds.join(',')}`); return { changed: movedTaskIds.length > 0, movedTaskIds, fromAgentIds, toAgentIds, reason };
  }

  health(swarmId: string): SwarmHealthSnapshot { const swarm = this.requireSwarm(swarmId); const members = swarm.members.filter((member) => member.status !== 'left'); const activeTasks = members.reduce((sum, member) => sum + member.currentTasks.length, 0); const failureStats = [...this.failures.values()].reduce((sum, value) => ({ failed: sum.failed + value.failed, timeouts: sum.timeouts + value.timeouts }), { failed: 0, timeouts: 0 }); const totalTasks = Math.max(1, activeTasks + failureStats.failed); const snapshot: SwarmHealthSnapshot = { swarmId, activeAgents: members.filter((member) => ['active', 'idle'].includes(member.status)).length, idleAgents: members.filter((member) => member.status === 'idle').length, overloadedAgents: members.filter((member) => member.status === 'overloaded' || member.currentTasks.length > 1).length, unhealthyAgents: members.filter((member) => ['unhealthy', 'offline'].includes(member.status)).length, activeTasks, failedTasks: failureStats.failed, timedOutTasks: failureStats.timeouts, queueWaitMs: this.opts.scheduler.list().length ? this.opts.queueWaitThresholdMs : 0, utilization: members.length ? Number(Math.min(1, activeTasks / (members.length * 3)).toFixed(4)) : 0, failureRate: Number((failureStats.failed / totalTasks).toFixed(4)), handoffs: [...this.handoffs.values()].reduce((sum, entries) => sum + entries.length, 0), stalls: 0, securityDenials: 0, observedAt: now() }; return snapshot; }

  async authorize(swarmId: string, approvedBy: string): Promise<Swarm> { const swarm = this.requireSwarm(swarmId); if (!approvedBy.trim()) throw new Error('approvedBy is required'); swarm.approvedBy = approvedBy.trim(); swarm.updatedAt = now(); await this.emit('swarm.authorized', swarmId, { approvedBy: swarm.approvedBy }); return clone(swarm); }

  async recordFailure(swarmId: string, taskId: string, timedOut = false): Promise<SwarmHealthSnapshot> { const current = this.failures.get(taskId) ?? { failed: 0, timeouts: 0 }; current.failed += 1; if (timedOut) current.timeouts += 1; this.failures.set(taskId, current); await this.emit('swarm.task.failed', swarmId, { taskId, timedOut }); return this.health(swarmId); }

  collaboration(swarmId: string): CollaborationGraph { this.requireSwarm(swarmId); const memberIds = new Set(this.requireSwarm(swarmId).members.map((member) => member.agentId)); return { nodes: [...this.graphNodes.values()].filter((node) => node.type === 'task' || memberIds.has(node.id.replace('agent:', '') as AgentId)).map((node) => clone(node)), edges: this.graphEdges.filter((edge) => !edge.from.startsWith('agent:') || memberIds.has(edge.from.replace('agent:', '') as AgentId)).map((edge) => clone(edge)) }; }
  neighbors(swarmId: string, nodeId: string): string[] { return [...new Set(this.collaboration(swarmId).edges.flatMap((edge) => edge.from === nodeId ? [edge.to] : edge.to === nodeId ? [edge.from] : []))].sort(); }
  collaborationHistory(swarmId: string): CollaborationEdge[] { return this.collaboration(swarmId).edges.filter((edge) => edge.type === 'delegation' || edge.type === 'handoff' || edge.type === 'rebalance'); }
  taskFlow(swarmId: string, taskId: string): CollaborationEdge[] { return this.collaboration(swarmId).edges.filter((edge) => edge.taskId === taskId); }
  criticalPath(swarmId: string): string[] { const graph = this.collaboration(swarmId); const tasks = graph.nodes.filter((node) => node.type === 'task').map((node) => node.id); const distance = new Map<string, number>(); const previous = new Map<string, string>(); const sorted = [...tasks].sort(); for (const task of sorted) { distance.set(task, distance.get(task) ?? 0); for (const edge of graph.edges.filter((candidate) => candidate.type === 'dependency' && candidate.to === task)) { const candidateDistance = (distance.get(edge.from) ?? 0) + 1; if (candidateDistance > (distance.get(task) ?? 0)) { distance.set(task, candidateDistance); previous.set(task, edge.from); } } } const end = [...distance.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]; const path: string[] = []; let cursor = end; while (cursor) { path.unshift(cursor.replace('task:', '')); cursor = previous.get(cursor); } return path; }

  consensus<T>(swarmId: string, votes: SwarmVote<T>[], strategy: 'MAJORITY' | 'UNANIMOUS' | 'WEIGHTED' = 'MAJORITY', requiredCapability = 'review'): SwarmConsensusResult<T> { this.requireSwarm(swarmId); const eligible = votes.filter((vote) => { const agent = this.opts.agents.get(vote.agentId); return agent.status !== 'offline' && agent.status !== 'unhealthy' && agent.capabilities.includes(requiredCapability); }); const normalized: Vote<T>[] = eligible.map((vote) => ({ voterId: vote.agentId, value: vote.value, confidence: vote.confidence, ...(vote.evidence ? { evidence: vote.evidence } : {}), weight: strategy === 'WEIGHTED' ? Math.max(0.01, this.opts.agents.get(vote.agentId).health.qualityScore * 0.7 + this.opts.agents.get(vote.agentId).health.successRate * 0.3) : 1 })); const mapped: ConsensusStrategy = strategy === 'WEIGHTED' ? 'weighted-majority' : 'majority'; const result = decide(normalized, { strategy: mapped, threshold: strategy === 'UNANIMOUS' ? 1 : 0.5 }); const decision = result.value; const dissent = decision === undefined ? eligible.map((vote) => vote.agentId) : eligible.filter((vote) => JSON.stringify(vote.value) !== JSON.stringify(decision)).map((vote) => vote.agentId); return { ...(decision !== undefined ? { decision } : {}), votes: clone(eligible), confidence: Number((result.support * (eligible.length ? result.participation / eligible.length : 0)).toFixed(4)), dissent, reached: strategy === 'UNANIMOUS' ? dissent.length === 0 && eligible.length > 0 : result.reached, strategy, rationale: [`eligibleVotes=${eligible.length}`, `excludedVotes=${votes.length - eligible.length}`, `capability=${requiredCapability}`, `strategy=${strategy}`, 'application-level consensus only'] }; }

  aggregate<T>(swarmId: string, input: { taskId: string; agentId?: AgentId; value?: T; success: boolean; score?: number; warning?: string }[]): SwarmResult<T> { this.requireSwarm(swarmId); const completedTasks = input.filter((item) => item.success).map((item) => item.taskId); const failedTasks = input.filter((item) => !item.success).map((item) => item.taskId); const scored = input.filter((item) => item.score !== undefined).map((item) => item.score!); const score = scored.length ? Number((scored.reduce((sum, value) => sum + value, 0) / scored.length).toFixed(4)) : (input.length ? Number((completedTasks.length / input.length).toFixed(4)) : 0); const warnings = input.filter((item) => item.warning).map((item) => item.warning!); return { success: input.length > 0 && failedTasks.length === 0, score, summary: `${completedTasks.length} completed, ${failedTasks.length} failed`, completedTasks, failedTasks, decisions: [], warnings, provenance: input.map((item) => ({ taskId: item.taskId, ...(item.agentId ? { agentId: item.agentId } : {}), source: 'swarm-result' })), outputs: input.filter((item) => item.value !== undefined).map((item) => ({ taskId: item.taskId, ...(item.agentId ? { agentId: item.agentId } : {}), value: item.value! })) }; }

  explainTeamFormation(swarmId: string): string[] { const swarm = this.requireSwarm(swarmId); return [`members=${swarm.members.filter((member) => member.status !== 'left').length}`, `maxAgents=${swarm.maxAgents}`, `minAgents=${swarm.minAgents}`, 'capability matching is a hard constraint', 'routing considers health, reputation, availability, specialization, and memory-compatible signals']; }
  explainTopology(swarmId: string): string[] { const swarm = this.requireSwarm(swarmId); const tasks = [...this.tasks.values()].filter((task) => this.collaboration(swarmId).nodes.some((node) => node.id === `task:${task.id}`)); const decision = this.chooseTopology(swarm, tasks); return [`current=${swarm.topology}`, `candidate=${decision.next}`, ...decision.reasons]; }
  explainScale(swarmId: string): string[] { const swarm = this.requireSwarm(swarmId); const active = swarm.members.filter((member) => member.status !== 'left').length; return [`activeAgents=${active}`, `bounds=${swarm.minAgents}-${swarm.maxAgents}`, `registryCapacity=${this.opts.agents.list().length}`, active < swarm.maxAgents ? 'scale-up is possible within registry capacity' : 'scale-up is bounded by maxAgents']; }
  explainHandoff(swarmId: string): string[] { this.requireSwarm(swarmId); const history = [...this.handoffs.values()].flat().filter((handoff) => handoff.swarmId === swarmId); return [`handoffs=${history.length}`, `maxHandoffs=${this.opts.maxHandoffs}`, 'reverse edges and repeated receivers are rejected to prevent loops']; }
  explainRebalance(swarmId: string): string[] { const health = this.health(swarmId); return [`overloadedAgents=${health.overloadedAgents}`, `utilization=${health.utilization}`, `failureRate=${health.failureRate}`, 'only idle compatible members are considered as replacement targets']; }
  explainCoordinator(swarmId: string): string[] { const swarm = this.requireSwarm(swarmId); return [`coordinator=${swarm.coordinatorId ?? 'none'}`, 'coordinator selection prefers planning capability, then reputation, then stable agent ID']; }
  explainConsensus<T>(swarmId: string, votes: SwarmVote<T>[], strategy: 'MAJORITY' | 'UNANIMOUS' | 'WEIGHTED' = 'MAJORITY'): SwarmConsensusResult<T> { return this.consensus(swarmId, votes, strategy); }

  async monitor(swarmId: string): Promise<SwarmHealthSnapshot> { const snapshot = this.health(swarmId); const swarm = this.requireSwarm(swarmId); for (const member of swarm.members) { if (member.status === 'unhealthy' || member.status === 'offline') await this.emit('swarm.agent.unhealthy', swarmId, { agentId: member.agentId, status: member.status }); if (member.currentTasks.length > 1) await this.emit('swarm.agent.overloaded', swarmId, { agentId: member.agentId, currentTasks: member.currentTasks.length }); } if (snapshot.activeTasks > 0 && snapshot.failureRate >= this.opts.failureRateThreshold) await this.emit('swarm.task.stalled', swarmId, { failureRate: snapshot.failureRate }); return snapshot; }

  private async assign(swarm: Swarm, task: DynamicSwarmTask, agentId: AgentId, mode: DelegationMode, role?: SwarmRole, reserveLease = true): Promise<DelegationRecord> { const agent = this.opts.agents.get(agentId); if (!capabilitiesMatch(agent, task.requiredCapabilities)) throw new Error(`agent ${agentId} does not satisfy task capabilities`); let member = swarm.members.find((candidate) => candidate.agentId === agentId && candidate.status !== 'left'); if (!member) { member = await this.addAgent(swarm.id, agentId, role ? [role] : [roleForTask(task)]); } if (member.status === 'paused' || member.status === 'offline' || member.status === 'unhealthy') throw new Error(`agent ${agentId} cannot accept delegated work while ${member.status}`); const lease = reserveLease ? this.opts.scheduler.acquire(task.id, agentId) : undefined; if (reserveLease && !lease) throw new Error(`scheduler rejected delegation for task ${task.id}`); if (reserveLease) member.currentTasks = [...new Set([...member.currentTasks, task.id])]; member.status = memberStatus(agent, member.currentTasks.length); member.lastActivityAt = now(); const delegation: DelegationRecord = { id: id('delegation'), swarmId: swarm.id, taskId: task.id, agentId, mode, ...(role ? { role } : {}), capabilities: [...task.requiredCapabilities], ...(lease ? { leaseId: lease.id } : {}), status: 'assigned', assignedAt: now() }; this.delegations.set(delegation.id, delegation); this.addGraphEdge({ from: `agent:${agentId}`, to: `task:${task.id}`, type: 'delegation', taskId: task.id, createdAt: now() }); await this.emit('swarm.task.delegated', swarm.id, { delegation: clone(delegation) }); return clone(delegation); }
  private async transferTask(swarm: Swarm, taskId: string, fromAgentId: AgentId, toAgentId: AgentId, reason: string): Promise<void> { const task = this.tasks.get(taskId); if (!task) return; const old = [...this.delegations.values()].reverse().find((delegation) => delegation.swarmId === swarm.id && delegation.taskId === taskId && delegation.agentId === fromAgentId && delegation.status === 'assigned'); if (old?.leaseId) this.opts.scheduler.release(old.leaseId); if (old) old.status = 'handed-off'; const from = this.requireMember(swarm, fromAgentId); from.currentTasks = from.currentTasks.filter((candidate) => candidate !== taskId); from.status = from.currentTasks.length ? 'active' : 'idle'; const target = this.requireMember(swarm, toAgentId); const lease = this.opts.scheduler.acquire(taskId, toAgentId); if (!lease) throw new Error(`scheduler rejected rebalanced task ${taskId}`); target.currentTasks.push(taskId); target.status = 'active'; this.addGraphEdge({ from: `agent:${fromAgentId}`, to: `agent:${toAgentId}`, type: 'rebalance', taskId, createdAt: now() }); await this.emit('swarm.task.rebalanced', swarm.id, { taskId, fromAgentId, toAgentId, reason, leaseId: lease.id }); }
  private routingCandidates(members: SwarmMember[], required: string[]): RoutingCandidate[] { return members.filter((member) => !['paused', 'offline', 'unhealthy'].includes(member.status) && capabilitiesMatch(this.opts.agents.get(member.agentId), required)).map((member) => { const agent = this.opts.agents.get(member.agentId); return { agent, estimatedCostUsd: 0, availability: Math.max(0.05, 1 - member.currentTasks.length / 3), memoryRelevance: member.reputation, learningBonus: 0 }; }); }
  private route(task: DynamicSwarmTask, candidates: RoutingCandidate[], strategy: Swarm['strategy']): RoutingDecision { if (!candidates.length) throw new Error(`no available agent satisfies task ${task.id}`); return this.opts.router.route({ taskType: 'swarm-delegation', requiredCapabilities: task.requiredCapabilities, complexity: task.risk === 'CRITICAL' ? 1 : task.risk === 'HIGH' ? 0.8 : 0.4, securityLevel: task.risk === 'CRITICAL' ? 'critical' : task.risk === 'HIGH' ? 'sensitive' : 'standard' }, candidates, strategy); }
  private chooseTopology(swarm: Swarm, tasks: DynamicSwarmTask[]): TopologyDecision { const dependencyCount = tasks.reduce((sum, task) => sum + task.dependencies.length, 0); const parallelCount = tasks.filter((task) => task.parallelizable).length; const highRisk = tasks.some((task) => task.risk === 'HIGH' || task.risk === 'CRITICAL'); const next: DynamicSwarmTopology = highRisk ? 'hierarchical' : dependencyCount >= Math.max(2, tasks.length / 2) ? 'pipeline' : parallelCount >= Math.max(2, tasks.length / 2) ? 'parallel' : tasks.length >= 6 ? 'mesh' : swarm.topology === 'adaptive' ? 'hybrid' : swarm.topology; return { previous: swarm.topology, next, changed: swarm.topology !== next, reasons: [highRisk ? 'high risk requires coordinator and security review' : 'risk within standard bounds', dependencyCount ? `dependencies=${dependencyCount}` : 'low dependency density', parallelCount ? `parallelTasks=${parallelCount}` : 'no parallel task signal'] }; }
  private chooseCoordinator(swarm: Swarm, excluded?: AgentId): SwarmMember | undefined { return swarm.members.filter((member) => member.agentId !== excluded && member.status !== 'left' && member.status !== 'offline' && member.status !== 'unhealthy').sort((left, right) => (right.capabilities.includes('planning') ? 1 : 0) - (left.capabilities.includes('planning') ? 1 : 0) || right.reputation - left.reputation || left.agentId.localeCompare(right.agentId))[0]; }
  private requireSwarm(swarmId: string): Swarm { const swarm = this.swarms.get(swarmId); if (!swarm) throw new Error(`unknown swarm ${swarmId}`); return swarm; }
  private assertAuthorized(swarm: Swarm): void { if ((swarm.risk === 'HIGH' || swarm.risk === 'CRITICAL') && !swarm.approvedBy) throw new Error(`explicit authorization required before operating high-risk swarm ${swarm.id}`); }
  private requireMember(swarm: Swarm, agentId: AgentId): SwarmMember { const member = swarm.members.find((candidate) => candidate.agentId === agentId && candidate.status !== 'left'); if (!member) throw new Error(`agent ${agentId} is not a member of swarm ${swarm.id}`); return member; }
  private addGraphNode(node: CollaborationNode): void { if (!this.graphNodes.has(node.id)) this.graphNodes.set(node.id, node); }
  private addGraphEdge(edge: CollaborationEdge): void { if (!this.graphEdges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.type === edge.type && candidate.taskId === edge.taskId)) this.graphEdges.push(edge); }
  private async emit(type: string, swarmId: string, payload: Record<string, unknown>): Promise<void> { if (this.opts.eventSink) await this.opts.eventSink({ type, swarmId, payload }); }
  private async learn(swarm: Swarm, type: 'successful-team' | 'handoff' | 'rebalance' | 'topology', content: string): Promise<MemoryEntry | undefined> { if (!this.opts.memory) return undefined; return this.opts.memory.create({ namespace: `swarm:${swarm.id}`, type: type === 'successful-team' ? 'pattern' : type === 'handoff' ? 'decision' : 'observation', content: `M13 ${type}: ${content}`, metadata: { swarmId: swarm.id, goalId: swarm.goalId, type }, source: 'm13-swarm', confidence: 0.7, tags: ['swarm', `swarm:${swarm.id}`, type], provenance: { sourceType: 'system', sourceId: swarm.id, timestamp: now(), swarmId: swarm.id, confidence: 0.7 }, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [swarm.id], owner: this.opts.subject ?? 'swarm' } }, { subject: this.opts.subject ?? 'swarm', swarmIds: [swarm.id] }); }
}

const roleValues: Record<SwarmRole, true> = { COORDINATOR: true, PLANNER: true, RESEARCHER: true, IMPLEMENTER: true, TESTER: true, REVIEWER: true, SECURITY: true, PERFORMANCE: true, MEMORY: true, OBSERVER: true };

export class SwarmHealthMonitor {
  constructor(private readonly manager: DynamicSwarmManager) {}
  async observe(swarmId: string): Promise<SwarmHealthSnapshot> { return this.manager.monitor(swarmId); }
  async rebalanceIfNeeded(swarmId: string): Promise<RebalanceResult> { const health = this.manager.health(swarmId); return health.overloadedAgents > 0 || health.failureRate >= 0.25 ? this.manager.rebalance(swarmId, `health overloaded=${health.overloadedAgents};failureRate=${health.failureRate}`) : { changed: false, movedTaskIds: [], fromAgentIds: [], toAgentIds: [], reason: 'health thresholds not exceeded' }; }
}
