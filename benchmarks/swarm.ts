import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import type { DynamicSwarmTask } from '../packages/swarm/src/index.js';

function stats(values: number[]): { average: number; p50: number; p95: number } { const sorted = [...values].sort((left, right) => left - right); const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0; return { average: Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(4)), p50: Number(at(0.5).toFixed(4)), p95: Number(at(0.95).toFixed(4)) }; }
function elapsed(started: number): number { return Number((performance.now() - started).toFixed(4)); }
function task(index: number): DynamicSwarmTask { const capability = index % 4 === 0 ? 'analysis' : index % 4 === 1 ? 'coding' : index % 4 === 2 ? 'testing' : 'review'; return { id: `m13-benchmark-task-${index}`, title: `Benchmark task ${index}`, requiredCapabilities: [capability], dependencies: index > 0 && index % 10 === 0 ? [`m13-benchmark-task-${index - 1}`] : [], parallelizable: index % 10 !== 0, risk: index % 97 === 0 ? 'HIGH' : 'LOW' }; }

const directory = await mkdtemp(join(tmpdir(), 'helix-m13-benchmark-'));
try {
  const runtime = new HelixRuntime({ dataDirectory: directory, learningAsync: false });
  await runtime.init();
  for (let index = runtime.agents.list().length; index < 100; index += 1) runtime.agents.register({ name: `m13-benchmark-agent-${index}`, role: 'autonomous swarm worker', capabilities: ['analysis', 'coding', 'testing', 'review', 'quality'] });
  const manager = runtime.swarms;
  const endToEndStarted = performance.now();
  const swarm = await manager.create({ name: 'M13 measured swarm', goalId: 'benchmark-goal', maxAgents: 100, minAgents: 1, topology: 'adaptive', strategy: 'adaptive' });
  const scaleStarted = performance.now();
  const scale = await manager.scale(swarm.id, 100);
  const scaleMs = elapsed(scaleStarted);
  const tasks = Array.from({ length: 1_000 }, (_, index) => task(index));
  const formationStarted = performance.now();
  const formation = await manager.form(swarm.id, tasks);
  const formationMs = elapsed(formationStarted);
  const memoryLatencies: number[] = [];
  for (let index = 0; index < 100; index += 1) { const started = performance.now(); await runtime.searchMemory({ query: 'M13 successful team', namespace: `swarm:${swarm.id}`, limit: 4, context: { subject: 'runtime', swarmIds: [swarm.id] } }); memoryLatencies.push(elapsed(started)); }
  const delegationStarted = performance.now();
  const delegated = await manager.delegate(swarm.id, task(10_001), 'swarm');
  const delegationMs = elapsed(delegationStarted);
  const completionStarted = performance.now();
  await manager.completeDelegation(swarm.id, delegated.id, true);
  const completionMs = elapsed(completionStarted);
  const failureStarted = performance.now();
  await manager.recordFailure(swarm.id, tasks[0]!.id, true);
  await manager.recordFailure(swarm.id, tasks[1]!.id, false);
  const health = await manager.monitor(swarm.id);
  const failureMs = elapsed(failureStarted);
  const first = formation.swarm.members[0]!;
  const second = formation.swarm.members[1]!;
  const loadCapability = first.capabilities.find((capability) => ['analysis', 'coding', 'testing', 'review'].includes(capability)) ?? 'analysis';
  const rebalancingSwarm = await manager.create({ name: 'M13 rebalancing sample', goalId: 'benchmark-rebalance', maxAgents: 2, minAgents: 1 });
  await manager.addAgent(rebalancingSwarm.id, first.agentId, ['IMPLEMENTER']);
  await manager.addAgent(rebalancingSwarm.id, second.agentId, ['IMPLEMENTER']);
  const overloadOne = await manager.delegate(rebalancingSwarm.id, { ...task(10_002), requiredCapabilities: [loadCapability] }, first.agentId);
  const overloadTwo = await manager.delegate(rebalancingSwarm.id, { ...task(10_003), requiredCapabilities: [loadCapability] }, first.agentId);
  const rebalanceStarted = performance.now();
  const rebalance = await manager.rebalance(rebalancingSwarm.id, 'benchmark overload threshold');
  const rebalanceMs = elapsed(rebalanceStarted);
  await manager.completeDelegation(rebalancingSwarm.id, overloadOne.id, true).catch(() => undefined);
  await manager.completeDelegation(rebalancingSwarm.id, overloadTwo.id, true).catch(() => undefined);
  const reviewers = formation.swarm.members.filter((member) => member.capabilities.includes('review')).slice(0, 3);
  const consensusStarted = performance.now();
  const consensus = manager.consensus(swarm.id, reviewers.map((member, index) => ({ agentId: member.agentId, value: index === 2 ? 'reject' : 'approve', confidence: 0.8 })), 'MAJORITY');
  const consensusMs = elapsed(consensusStarted);
  const aggregateStarted = performance.now();
  const aggregate = manager.aggregate(swarm.id, [{ taskId: tasks[0]!.id, agentId: first.agentId, value: 'measured', success: true, score: 0.9 }, { taskId: tasks[1]!.id, agentId: second.agentId, success: true, score: 0.8 }]);
  const aggregateMs = elapsed(aggregateStarted);
  const endToEndMs = elapsed(endToEndStarted);
  const result = { benchmark: 'm13-autonomous-swarm', deterministic: true, agentCount: runtime.agents.list().length, swarmMemberCount: formation.swarm.members.length, taskUnits: tasks.length, topology: formation.swarm.topology, scale: { added: scale.added.length, elapsedMs: scaleMs }, stagesMs: { endToEnd: endToEndMs, formation: formationMs, delegation: delegationMs, completion: completionMs, failureAndHealth: failureMs, rebalance: rebalanceMs, consensus: consensusMs, aggregation: aggregateMs }, memoryLookup: stats(memoryLatencies), throughputTaskUnitsPerSecond: Number((tasks.length / (formationMs / 1_000)).toFixed(2)), health: { failedTasks: health.failedTasks, timedOutTasks: health.timedOutTasks, utilization: health.utilization, failureRate: health.failureRate }, rebalancing: { changed: rebalance.changed, movedTasks: rebalance.movedTaskIds.length }, consensus: { reached: consensus.reached, decision: consensus.decision, confidence: consensus.confidence, dissent: consensus.dissent.length }, aggregation: { success: aggregate.success, score: aggregate.score, completedTasks: aggregate.completedTasks.length, failedTasks: aggregate.failedTasks.length }, bounded: { maxAgents: formation.swarm.maxAgents, maxHandoffs: 3, taskFanoutLimit: formation.swarm.maxAgents * 16 } };
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
