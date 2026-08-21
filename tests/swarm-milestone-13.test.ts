import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import type { AgentId } from '../packages/core/src/index.js';
import type { DynamicSwarmTask, SwarmRole } from '../packages/swarm/src/index.js';

async function withRuntime<T>(prefix: string, run: (runtime: HelixRuntime) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { return await run(new HelixRuntime({ dataDirectory: directory, learningAsync: false })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const task = (id: string, capabilities: string[], role?: SwarmRole): DynamicSwarmTask => ({ id, title: `Task ${id}`, requiredCapabilities: capabilities, dependencies: [], ...(role ? { role } : {}), parallelizable: true });
const codingAgents = (runtime: HelixRuntime): AgentId[] => runtime.agents.list().filter((agent) => agent.capabilities.includes('coding')).slice(0, 4).map((agent) => agent.id);
const reviewAgents = (runtime: HelixRuntime): AgentId[] => { const existing = runtime.agents.list().filter((agent) => agent.capabilities.includes('review')); for (let index = existing.length; index < 4; index += 1) runtime.agents.register({ name: `m13-reviewer-${index}`, role: 'reviewer', capabilities: ['review', 'quality'] }); return runtime.agents.list().filter((agent) => agent.capabilities.includes('review')).slice(0, 4).map((agent) => agent.id); };

async function formed(runtime: HelixRuntime, options: { maxAgents?: number; minAgents?: number; topology?: 'hierarchical' | 'mesh' | 'adaptive' | 'pipeline' | 'parallel' | 'consensus' | 'hybrid'; strategy?: 'adaptive' | 'capability' | 'quality' | 'latency' | 'hybrid'; risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; approvedBy?: string } = {}) {
  const swarm = await runtime.swarms.create({ name: 'test-swarm', goalId: 'goal_test', maxAgents: options.maxAgents ?? 8, minAgents: options.minAgents ?? 1, ...(options.topology ? { topology: options.topology } : {}), ...(options.strategy ? { strategy: options.strategy } : {}), ...(options.risk ? { risk: options.risk } : {}), ...(options.approvedBy ? { approvedBy: options.approvedBy } : {}) });
  const formation = await runtime.swarms.form(swarm.id, [task('task-analysis', ['analysis']), task('task-code', ['coding']), task('task-test', ['testing']), task('task-review', ['review'])]);
  return { swarm: formation.swarm, formation };
}

test('M13 dynamic team creation forms a bounded capability-safe swarm', async () => withRuntime('helix-m13-team-', async (runtime) => {
  const { swarm, formation } = await formed(runtime);
  assert.equal(swarm.state, 'READY');
  assert.ok(swarm.members.length >= 1 && swarm.members.length <= swarm.maxAgents);
  assert.equal(formation.assignments.length, 4);
  assert.ok(formation.rationale.some((item) => item.includes('capability')));
}));

test('M13 role assignment is deterministic and covers task-specialized roles', async () => withRuntime('helix-m13-roles-', async (runtime) => {
  const { swarm } = await formed(runtime);
  const roles = new Set(swarm.members.flatMap((member) => member.roles));
  assert.ok(roles.has('IMPLEMENTER'));
  assert.ok(roles.has('TESTER'));
  assert.ok(roles.has('REVIEWER'));
}));

test('M13 coordinator promotion and demotion are explicit and deterministic', async () => withRuntime('helix-m13-coordinator-', async (runtime) => {
  const { swarm } = await formed(runtime);
  const first = swarm.members[0]!;
  const promoted = await runtime.swarms.promoteCoordinator(swarm.id, first.agentId);
  assert.equal(promoted.coordinatorId, first.agentId);
  assert.ok(promoted.members.find((member) => member.agentId === first.agentId)?.roles.includes('COORDINATOR'));
  const demoted = await runtime.swarms.demoteCoordinator(swarm.id, first.agentId);
  assert.notEqual(demoted.coordinatorId, first.agentId);
}));

test('M13 delegation supports direct, role, and swarm routing through AgentScheduler', async () => withRuntime('helix-m13-delegation-', async (runtime) => {
  const { swarm } = await formed(runtime);
  const coder = swarm.members.find((member) => member.capabilities.includes('coding'))!;
  const direct = await runtime.swarms.delegate(swarm.id, task('delegated-direct', ['coding']), coder.agentId);
  assert.equal(direct.mode, 'direct');
  assert.equal(runtime.scheduler.list().length, 1);
  await runtime.swarms.completeDelegation(swarm.id, direct.id);
  const role = await runtime.swarms.delegate(swarm.id, task('delegated-role', ['review']), 'REVIEWER');
  assert.equal(role.mode, 'role');
  const routed = await runtime.swarms.delegate(swarm.id, task('delegated-swarm', ['analysis']), 'swarm');
  assert.equal(routed.mode, 'swarm');
  await runtime.swarms.completeDelegation(swarm.id, role.id);
  await runtime.swarms.completeDelegation(swarm.id, routed.id);
  assert.equal(runtime.scheduler.list().length, 0);
}));

test('M13 handoff transfers a task and records reason/history', async () => withRuntime('helix-m13-handoff-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'handoff', goalId: 'goal_handoff', maxAgents: 3 });
  const [first, second] = codingAgents(runtime);
  await runtime.swarms.addAgent(swarm.id, first!, ['IMPLEMENTER']);
  await runtime.swarms.addAgent(swarm.id, second!, ['IMPLEMENTER']);
  const delegated = await runtime.swarms.delegate(swarm.id, task('handoff-task', ['coding']), first!);
  const result = await runtime.swarms.handoff(swarm.id, delegated.taskId, first!, second!, 'tester found a bounded defect');
  assert.equal(result.handoff.reason, 'tester found a bounded defect');
  assert.equal(result.delegation.agentId, second);
  assert.equal(result.delegation.status, 'assigned');
  await runtime.swarms.completeDelegation(swarm.id, result.delegation.id);
}));

test('M13 handoff loop prevention rejects reverse and repeated receiver cycles', async () => withRuntime('helix-m13-loop-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'loop', goalId: 'goal_loop', maxAgents: 3 });
  const [first, second] = codingAgents(runtime);
  await runtime.swarms.addAgent(swarm.id, first!, ['IMPLEMENTER']);
  await runtime.swarms.addAgent(swarm.id, second!, ['TESTER']);
  const delegated = await runtime.swarms.delegate(swarm.id, task('loop-task', ['coding']), first!);
  const handoff = await runtime.swarms.handoff(swarm.id, delegated.taskId, first!, second!, 'test handoff');
  await assert.rejects(() => runtime.swarms.handoff(swarm.id, delegated.taskId, second!, first!, 'reverse loop'), /loop detected/);
  await runtime.swarms.completeDelegation(swarm.id, handoff.delegation.id);
}));

test('M13 topology switches with explicit explainable decisions', async () => withRuntime('helix-m13-topology-', async (runtime) => {
  const { swarm } = await formed(runtime, { topology: 'adaptive' });
  const decision = await runtime.swarms.switchTopology(swarm.id, 'mesh', 'parallel independent tasks detected');
  assert.equal(decision.previous, 'parallel');
  assert.equal(decision.next, 'mesh');
  assert.equal(decision.changed, true);
}));

test('M13 scale-up respects maxAgents and registry capacity', async () => withRuntime('helix-m13-scale-up-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'scale-up', goalId: 'goal_scale', minAgents: 1, maxAgents: 5 });
  const decision = await runtime.swarms.scale(swarm.id, 5);
  assert.equal(decision.direction, 'up');
  assert.equal(decision.added.length, 5);
  assert.equal(runtime.swarms.get(swarm.id).members.filter((member) => member.status !== 'left').length, 5);
  await assert.rejects(() => runtime.swarms.scale(swarm.id, 6), /between 1 and 5/);
}));

test('M13 scale-down collapses idle members but preserves bounds', async () => withRuntime('helix-m13-scale-down-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'scale-down', goalId: 'goal_scale_down', minAgents: 1, maxAgents: 4 });
  await runtime.swarms.scale(swarm.id, 4);
  const decision = await runtime.swarms.scale(swarm.id, 1);
  assert.equal(decision.direction, 'down');
  assert.equal(decision.removed.length, 3);
  assert.equal(runtime.swarms.get(swarm.id).members.filter((member) => member.status !== 'left').length, 1);
}));

test('M13 overloaded-agent replacement rebalances compatible work', async () => withRuntime('helix-m13-rebalance-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'rebalance', goalId: 'goal_rebalance', maxAgents: 3 });
  const [first, second] = codingAgents(runtime);
  await runtime.swarms.addAgent(swarm.id, first!, ['IMPLEMENTER']);
  await runtime.swarms.addAgent(swarm.id, second!, ['IMPLEMENTER']);
  await runtime.swarms.delegate(swarm.id, task('busy-1', ['coding']), first!);
  await runtime.swarms.delegate(swarm.id, task('busy-2', ['coding']), first!);
  const result = await runtime.swarms.rebalance(swarm.id, 'agent overloaded');
  assert.equal(result.changed, true);
  assert.equal(result.movedTaskIds.length, 1);
  assert.equal(result.toAgentIds[0], second);
}));

test('M13 health monitor reports failures, timeouts, utilization, and overload', async () => withRuntime('helix-m13-health-', async (runtime) => {
  const { swarm } = await formed(runtime);
  const member = swarm.members[0]!;
  await runtime.swarms.delegate(swarm.id, task('health-task-1', ['analysis']), member.agentId);
  await runtime.swarms.delegate(swarm.id, task('health-task-2', ['analysis']), member.agentId);
  await runtime.swarms.recordFailure(swarm.id, 'health-task-1', true);
  const health = await runtime.swarms.health(swarm.id);
  assert.equal(health.failedTasks, 1);
  assert.equal(health.timedOutTasks, 1);
  assert.ok(health.overloadedAgents >= 1);
}));

test('M13 collaboration graph exposes nodes, neighbors, flow, history, and critical path', async () => withRuntime('helix-m13-graph-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'graph', goalId: 'goal_graph', maxAgents: 2 });
  const [first] = codingAgents(runtime);
  await runtime.swarms.addAgent(swarm.id, first!, ['IMPLEMENTER']);
  await runtime.swarms.delegate(swarm.id, { ...task('graph-a', ['coding']), dependencies: [] }, first!);
  await runtime.swarms.delegate(swarm.id, { ...task('graph-b', ['coding']), dependencies: ['graph-a'] }, first!);
  const graph = runtime.swarms.collaboration(swarm.id);
  assert.ok(graph.nodes.some((node) => node.id === 'task:graph-a'));
  assert.ok(runtime.swarms.neighbors(swarm.id, `agent:${first}`).includes('task:graph-a'));
  assert.ok(runtime.swarms.taskFlow(swarm.id, 'graph-b').some((edge) => edge.type === 'dependency'));
  assert.deepEqual(runtime.swarms.criticalPath(swarm.id), ['graph-a', 'graph-b']);
}));

test('M13 majority consensus excludes capability-mismatched voters', async () => withRuntime('helix-m13-consensus-majority-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'consensus', goalId: 'goal_consensus', maxAgents: 4 });
  const voters = reviewAgents(runtime).slice(0, 3);
  for (const voter of voters) await runtime.swarms.addAgent(swarm.id, voter, ['REVIEWER']);
  const result = runtime.swarms.consensus(swarm.id, [{ agentId: voters[0]!, value: 'approve', confidence: 0.9 }, { agentId: voters[1]!, value: 'approve', confidence: 0.8 }, { agentId: voters[2]!, value: 'reject', confidence: 0.8 }, { agentId: runtime.agents.list().find((agent) => !agent.capabilities.includes('review'))!.id, value: 'approve', confidence: 1 }], 'MAJORITY');
  assert.equal(result.decision, 'approve');
  assert.equal(result.reached, true);
  assert.equal(result.votes.length, 3);
}));

test('M13 weighted consensus uses health and quality weights without Byzantine claims', async () => withRuntime('helix-m13-consensus-weighted-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'weighted', goalId: 'goal_weighted', maxAgents: 3 });
  const voters = reviewAgents(runtime).slice(0, 2);
  for (const voter of voters) await runtime.swarms.addAgent(swarm.id, voter, ['REVIEWER']);
  runtime.agents.recordOutcome(voters[0]!, { taskType: 'review', domain: 'swarm', success: true, quality: 1, latencyMs: 1, tokens: 0 });
  const result = runtime.swarms.consensus(swarm.id, [{ agentId: voters[0]!, value: 'approve', confidence: 1 }, { agentId: voters[1]!, value: 'reject', confidence: 0.5 }], 'WEIGHTED');
  assert.ok(result.strategy === 'WEIGHTED');
  assert.ok(result.confidence >= 0);
  assert.ok(result.rationale.some((item) => item.includes('application-level')));
}));

test('M13 result aggregation reports only supplied outputs and evidence', async () => withRuntime('helix-m13-aggregate-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'aggregate', goalId: 'goal_aggregate' });
  const result = runtime.swarms.aggregate(swarm.id, [{ taskId: 'a', success: true, value: 'evidence-a', score: 0.9 }, { taskId: 'b', success: false, warning: 'worker failed' }]);
  assert.equal(result.success, false);
  assert.equal(result.completedTasks.length, 1);
  assert.equal(result.failedTasks.length, 1);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.score, 0.9);
  assert.deepEqual(result.warnings, ['worker failed']);
}));

test('M13 memory learning stores swarm evidence in the M10 SQLite namespace', async () => withRuntime('helix-m13-memory-', async (runtime) => {
  const { swarm } = await formed(runtime);
  const entries = await runtime.searchMemory({ namespace: `swarm:${swarm.id}`, context: { subject: 'runtime', swarmIds: [swarm.id] }, query: 'M13 successful team', limit: 10 });
  assert.ok(entries.some((entry) => entry.entry.swarmId === swarm.id || entry.entry.namespace === `swarm:${swarm.id}`));
}));

test('M13 delegation reserves and releases the existing scheduler lease', async () => withRuntime('helix-m13-scheduler-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'scheduler', goalId: 'goal_scheduler', maxAgents: 2 });
  const [agent] = codingAgents(runtime);
  await runtime.swarms.addAgent(swarm.id, agent!, ['IMPLEMENTER']);
  const delegation = await runtime.swarms.delegate(swarm.id, task('scheduler-task', ['coding']), agent!);
  assert.equal(runtime.scheduler.list().some((lease) => lease.taskId === delegation.taskId), true);
  await runtime.swarms.completeDelegation(swarm.id, delegation.id);
  assert.equal(runtime.scheduler.list().length, 0);
}));

test('M13 worker integration retains M12 orchestrator execution semantics', async () => withRuntime('helix-m13-worker-', async (runtime) => {
  const result = await runtime.createOrchestrator({ subject: 'm13-test' }).run({ title: 'Document swarm worker result', description: 'Write a deterministic worker result summary' });
  assert.equal(result.state, 'COMPLETED');
  assert.ok(result.steps.every((step) => step.status === 'completed'));
}));

test('M13 bounded failure simulation records timeout and does not loop indefinitely', async () => withRuntime('helix-m13-failure-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'failure', goalId: 'goal_failure', maxAgents: 2 });
  const [agent] = codingAgents(runtime);
  await runtime.swarms.addAgent(swarm.id, agent!, ['IMPLEMENTER']);
  await runtime.swarms.recordFailure(swarm.id, 'failed-task', true);
  await runtime.swarms.recordFailure(swarm.id, 'failed-task', true);
  const health = await runtime.swarms.health(swarm.id);
  assert.equal(health.failedTasks, 2);
  assert.equal(health.timedOutTasks, 2);
}));

test('M13 high-risk swarm operations require explicit authorization', async () => withRuntime('helix-m13-security-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'secure', goalId: 'goal_secure', risk: 'HIGH', maxAgents: 2 });
  await assert.rejects(() => runtime.swarms.form(swarm.id, [task('secure-task', ['security'])]), /explicit authorization/);
  await runtime.swarms.authorize(swarm.id, 'security-operator');
  const formation = await runtime.swarms.form(swarm.id, [task('secure-task', ['security'])]);
  assert.equal(formation.swarm.approvedBy, 'security-operator');
}));

test('M13 maxAgents enforcement rejects excess members and scale targets', async () => withRuntime('helix-m13-max-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'bounded', goalId: 'goal_bounded', maxAgents: 1 });
  const [first, second] = codingAgents(runtime);
  await runtime.swarms.addAgent(swarm.id, first!, ['IMPLEMENTER']);
  await assert.rejects(() => runtime.swarms.addAgent(swarm.id, second!, ['IMPLEMENTER']), /maxAgents=1/);
  await assert.rejects(() => runtime.swarms.scale(swarm.id, 2), /between 1 and 1/);
}));

test('M13 cancellation is terminal and invalid transitions are rejected', async () => withRuntime('helix-m13-cancel-', async (runtime) => {
  const swarm = await runtime.swarms.create({ name: 'cancel', goalId: 'goal_cancel' });
  const cancelled = await runtime.swarms.cancel(swarm.id);
  assert.equal(cancelled.state, 'CANCELLED');
  await assert.rejects(() => runtime.swarms.start(swarm.id), /invalid swarm transition/);
}));

test('M13 explainability covers team, topology, scaling, handoff, rebalance, and coordinator decisions', async () => withRuntime('helix-m13-explain-', async (runtime) => {
  const { swarm } = await formed(runtime);
  const explanation = { team: runtime.swarms.explainTeamFormation(swarm.id), topology: runtime.swarms.explainTopology(swarm.id), scale: runtime.swarms.explainScale(swarm.id), handoff: runtime.swarms.explainHandoff(swarm.id), rebalance: runtime.swarms.explainRebalance(swarm.id), coordinator: runtime.swarms.explainCoordinator(swarm.id) };
  for (const values of Object.values(explanation)) assert.ok(values.length > 0);
  assert.ok(explanation.team.some((item) => item.includes('hard constraint')));
}));

test('M13 100-agent swarm remains capability-safe and bounded', async () => withRuntime('helix-m13-100-', async (runtime) => {
  for (let index = runtime.agents.list().length; index < 100; index += 1) runtime.agents.register({ name: `m13-agent-${index}`, role: 'swarm worker', capabilities: ['analysis', 'coding', 'testing', 'review'] });
  const swarm = await runtime.swarms.create({ name: 'one-hundred', goalId: 'goal_100', maxAgents: 100, minAgents: 1 });
  const decision = await runtime.swarms.scale(swarm.id, 100);
  assert.equal(decision.added.length, 100);
  const formation = await runtime.swarms.form(swarm.id, [task('safe-analysis', ['analysis']), task('safe-code', ['coding']), task('safe-test', ['testing']), task('safe-review', ['review'])]);
  assert.equal(formation.assignments.length, 4);
  assert.equal(runtime.swarms.get(swarm.id).members.filter((member) => member.status !== 'left').length, 100);
  assert.ok(formation.assignments.every((assignment) => assignment.capabilities.every((capability) => assignment.capabilities.includes(capability))));
}));
