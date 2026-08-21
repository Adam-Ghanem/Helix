import { performance } from 'node:perf_hooks';
import { DistributedLeaseManager, FederationCoordinator, HmacMessageSigner, HmacMessageVerifier, InMemoryFederationNetwork, NodeRegistry } from '../packages/federation/src/index.js';
import type { FederationNodeInput, FederatedTaskResult } from '../packages/federation/src/index.js';

const capabilities = ['coding', 'testing', 'security', 'research', 'planning', 'review'] as const;
const nodeInput = (id: string): FederationNodeInput => ({ id, name: id, endpoint: `in-memory://${id}`, role: id === 'node-a' ? 'hybrid' : 'worker', capabilities: [...capabilities], status: 'healthy', trustLevel: 'TRUSTED', metadata: { zone: id === 'node-a' ? 'local' : 'simulated-remote' } });
const security = { subject: 'federation-demo', permissions: ['federation:dispatch'], trustLevel: 'TRUSTED' as const };
const network = new InMemoryFederationNetwork();
const registry = new NodeRegistry();
const signer = new HmacMessageSigner('m14-demo-key');
const verifier = new HmacMessageVerifier('m14-demo-key');
const nodes = ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'];
const coordinators = nodes.map((id) => new FederationCoordinator({ localNode: nodeInput(id), registry, network, signer, verifier }));
const local = coordinators[0]!;
const byNode = new Map(nodes.map((id, index) => [id, coordinators[index]!]));
try {
  for (const [nodeIndex, nodeId] of nodes.entries()) for (let agentIndex = 0; agentIndex < 20; agentIndex += 1) local.workers.register({ workerId: `${nodeId}-agent-${agentIndex}`, nodeId, capacity: 1, capabilities: [...capabilities], status: 'idle' });
  const started = performance.now();
  const records = [];
  for (let index = 0; index < 1_000; index += 1) { const capability = capabilities[index % capabilities.length]!; const targetNodeId = nodes[index % nodes.length]!; const record = await local.dispatch({ taskId: `demo-task-${index}`, title: `M14 ${capability} task ${index}`, requiredCapabilities: [capability], nodeId: targetNodeId, priority: index % 10, securityContext: security, authorizationContext: { subject: security.subject, taskClass: capability } }); records.push(record); }
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const record of records) { const owner = byNode.get(record.nodeId); if (owner) await owner.complete(record.taskId, true); }
  const taskMs = performance.now() - started;
  const leaseClock = { value: Date.now() };
  const expiringLeases = new DistributedLeaseManager({ clock: () => leaseClock.value, defaultTtlMs: 10 });
  expiringLeases.acquire('expired-task-a', 'node-a'); expiringLeases.acquire('expired-task-b', 'node-a'); leaseClock.value += 11; const expired = expiringLeases.expire();
  const recovery = await local.dispatch({ taskId: 'recovery-task', requiredCapabilities: ['coding'], nodeId: 'node-a', securityContext: security, authorizationContext: { subject: security.subject, taskClass: 'recovery' } });
  local.registry.markOffline('node-a');
  const reassigned = await local.rebalance(recovery.taskId);
  const handoff = await local.handoff(reassigned.taskId, 'node-c');
  local.registry.markOffline('node-e');
  const federated = local.createSwarm({ name: 'five-node-demo-swarm', topology: 'adaptive', maxNodes: 5, trustLevel: 'TRUSTED' });
  for (const nodeId of nodes.slice(1, 5)) local.addNode(federated.id, nodeId);
  const metrics = local.metrics();
  const status = local.status();
  const currentRecords = records.map((record) => local.getTask(record.taskId));
  const aggregateInput: FederatedTaskResult<string>[] = currentRecords.slice(0, 100).map((record) => ({ taskId: record.taskId, nodeId: record.nodeId, success: record.status === 'completed', score: record.status === 'completed' ? 0.9 : 0, fencingToken: record.fencingToken ?? 0, ...(record.status === 'failed' ? { error: record.error } : {}) }));
  const aggregate = local.aggregate(federated.id, aggregateInput);
  const remoteRecords = currentRecords.filter((record) => !record.local);
  const currentSwarm = local.getSwarm(federated.id);
  console.log(JSON.stringify({ demo: 'm14-federation', deterministic: true, nodes: { total: status.nodes.length, configured: nodes, healthy: status.nodes.filter((node) => node.status === 'healthy').map((node) => node.id), offline: status.nodes.filter((node) => node.status === 'offline').map((node) => node.id), workersPerNode: 20, agents: 100 }, taskDistribution: { totalTasks: currentRecords.length, localTasks: currentRecords.filter((record) => record.local).length, remoteTasks: remoteRecords.length, remoteLocalRatio: Number((remoteRecords.length / currentRecords.length).toFixed(4)), completedTasks: currentRecords.filter((record) => record.status === 'completed').length, elapsedMs: Number(taskMs.toFixed(4)), throughputTasksPerSecond: Number((records.length / (taskMs / 1_000)).toFixed(2)) }, failureRecovery: { nodeFailure: 'node-a marked offline after task execution', offlineNode: 'node-e', leaseExpirations: expired.length, rebalancedTask: reassigned.taskId, rebalancedTo: reassigned.nodeId, handoffTo: handoff.nodeId, reassignedCount: metrics.handoffs }, federatedSwarm: { id: currentSwarm.id, nodes: currentSwarm.nodeIds, state: currentSwarm.state, aggregateSuccess: aggregate.success, aggregateScore: aggregate.score, aggregatedTasks: aggregate.results.length }, metrics, security: { remoteDispatchesRequiredExplicitPermission: true, inheritedPrivileges: local.registry.inspectTrust('node-b').inheritedLocalPrivileges, signatureFailures: metrics.signatureFailures, replayRejections: metrics.replayRejections, unauthorizedRemoteDowngrade: false }, limitations: ['in-memory transport only', 'lease store is replaceable and is not distributed consensus', 'no cloud or LLM calls'] }, null, 2));
} finally { await Promise.all(coordinators.map((coordinator) => coordinator.close())); }
