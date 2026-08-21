import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import type { AgentId } from '../packages/core/src/index.js';
import type { DynamicSwarmTask } from '../packages/swarm/src/index.js';

const makeTask = (id: string, title: string, capabilities: string[], dependencies: string[] = [], parallelizable = true, risk: DynamicSwarmTask['risk'] = 'LOW'): DynamicSwarmTask => ({ id, title, requiredCapabilities: capabilities, dependencies, parallelizable, risk });

const directory = await mkdtemp(join(tmpdir(), 'helix-m13-demo-'));
try {
  const runtime = new HelixRuntime({ dataDirectory: directory, learningAsync: false });
  await runtime.init();
  for (let index = runtime.agents.list().length; index < 100; index += 1) runtime.agents.register({ name: `demo-agent-${index}`, role: 'autonomous swarm worker', capabilities: ['analysis', 'coding', 'testing', 'review', 'security', 'quality'] });
  const orchestrator = runtime.createOrchestrator({ subject: 'm13-demo' });
  const goals = await Promise.all([
    orchestrator.createGoal({ title: 'Build the release pipeline', description: 'Implement, test, and review a release pipeline.' }),
    orchestrator.createGoal({ title: 'Analyze parallel evidence', description: 'Analyze independent evidence streams in parallel.' }),
    orchestrator.createGoal({ title: 'Perform authorized security review', description: 'Review security controls before release.', risk: 'HIGH' }),
  ]);
  const pipeline = await orchestrator.createSwarm({ name: 'release-pipeline', goalId: goals[0]!.id, topology: 'adaptive', maxAgents: 6 });
  const pipelineFormation = await orchestrator.formSwarm(pipeline.id, [makeTask('release-design', 'Design release flow', ['analysis'], [], false), makeTask('release-implementation', 'Implement release flow', ['coding'], ['release-design'], false), makeTask('release-tests', 'Test release flow', ['testing'], ['release-implementation'], false), makeTask('release-review', 'Review release flow', ['review'], ['release-tests'], false)]);
  const parallel = await orchestrator.createSwarm({ name: 'parallel-analysis', goalId: goals[1]!.id, topology: 'adaptive', maxAgents: 8 });
  const parallelFormation = await orchestrator.formSwarm(parallel.id, [makeTask('evidence-a', 'Analyze evidence A', ['analysis']), makeTask('evidence-b', 'Analyze evidence B', ['analysis']), makeTask('evidence-c', 'Analyze evidence C', ['analysis']), makeTask('evidence-d', 'Analyze evidence D', ['analysis'])]);
  const secure = await orchestrator.createSwarm({ name: 'authorized-security-review', goalId: goals[2]!.id, topology: 'hierarchical', maxAgents: 6, risk: 'HIGH', approvedBy: 'security-operator' });
  const secureFormation = await orchestrator.formSwarm(secure.id, [makeTask('security-review', 'Review access controls', ['security'], [], false, 'HIGH'), makeTask('security-approval', 'Approve security result', ['review'], ['security-review'], false, 'HIGH')]);
  const implementer = pipelineFormation.swarm.members.find((member) => member.capabilities.includes('coding'))!;
  const handoffTarget = runtime.agents.list().find((agent) => agent.capabilities.includes('coding') && agent.id !== implementer.agentId)!;
  await orchestrator.addSwarmAgent(pipeline.id, handoffTarget.id, ['IMPLEMENTER']);
  const delegation = await orchestrator.delegateToSwarm(pipeline.id, makeTask('forced-failure', 'Forced worker failure', ['coding'], [], false), implementer.agentId);
  const failureHealth = await orchestrator.recordSwarmFailure(pipeline.id, delegation.taskId, true);
  const handoff = await orchestrator.handoffInSwarm(pipeline.id, delegation.taskId, implementer.agentId, handoffTarget.id, 'replacement implementer owns the failed task for diagnosis');
  const completed = await orchestrator.completeSwarmDelegation(pipeline.id, handoff.delegation.id, false);
  const rebound = await orchestrator.createSwarm({ name: 'rebalancing-sample', goalId: goals[0]!.id, topology: 'mesh', maxAgents: 2 });
  const coding = runtime.agents.list().filter((agent) => agent.capabilities.includes('coding')).slice(0, 2).map((agent) => agent.id as AgentId);
  await orchestrator.addSwarmAgent(rebound.id, coding[0]!, ['IMPLEMENTER']);
  await orchestrator.addSwarmAgent(rebound.id, coding[1]!, ['IMPLEMENTER']);
  const busyA = await orchestrator.delegateToSwarm(rebound.id, makeTask('rebalance-a', 'Rebalance A', ['coding']), coding[0]!);
  const busyB = await orchestrator.delegateToSwarm(rebound.id, makeTask('rebalance-b', 'Rebalance B', ['coding']), coding[0]!);
  const rebalance = await orchestrator.rebalanceSwarm(rebound.id, 'forced overloaded-agent recovery');
  await orchestrator.completeSwarmDelegation(rebound.id, busyA.id, true).catch(() => undefined);
  await orchestrator.completeSwarmDelegation(rebound.id, busyB.id, true).catch(() => undefined);
  const reviewers = secureFormation.swarm.members.filter((member) => member.capabilities.includes('review')).slice(0, 3);
  const consensus = orchestrator.swarmConsensus(secure.id, reviewers.map((member, index) => ({ agentId: member.agentId, value: index === 0 ? 'approve' : 'reject', confidence: 0.8 })), 'MAJORITY');
  const result = orchestrator.swarmAggregate(pipeline.id, [{ taskId: 'release-design', ...(pipelineFormation.swarm.members[0] ? { agentId: pipelineFormation.swarm.members[0].agentId } : {}), value: 'design evidence', success: true, score: 0.9 }, { taskId: 'forced-failure', agentId: completed.agentId, success: false, warning: 'forced failure retained as evidence' }]);
  const events = (await runtime.events.read()).filter((event) => event.type.startsWith('swarm.'));
  console.log(JSON.stringify({ demo: 'm13-autonomous-swarm', deterministic: true, agents: runtime.agents.list().length, goals: goals.map((goal) => ({ id: goal.id, title: goal.title })), swarms: [pipelineFormation.swarm, parallelFormation.swarm, secureFormation.swarm].map((swarm) => ({ id: swarm.id, goalId: swarm.goalId, topology: swarm.topology, members: swarm.members.length, risk: swarm.risk })), forcedFailure: { taskId: delegation.taskId, timedOut: true, failedTasks: failureHealth.failedTasks, handoffTo: handoff.delegation.agentId }, rebalancing: { changed: rebalance.changed, movedTasks: rebalance.movedTaskIds }, consensus: { reached: consensus.reached, decision: consensus.decision, dissent: consensus.dissent.length }, aggregation: result, learnedMemoryEntries: await runtime.memory.count({ subject: 'runtime', swarmIds: [pipeline.id] }), durableSwarmEvents: events.length, explainability: orchestrator.explainSwarm(pipeline.id) }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
