import { performance } from 'node:perf_hooks';
import { DistributedLeaseManager, FederationCoordinator, HmacMessageSigner, HmacMessageVerifier, InMemoryFederationNetwork, NodeRegistry, createFederationMessage } from '../packages/federation/src/index.js';
import type { FederationNodeInput, FederationRoutingTask } from '../packages/federation/src/index.js';

function summary(values: number[]): { average: number; p50: number; p95: number; p99: number } { const sorted = [...values].sort((left, right) => left - right); const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0; return { average: Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(4)), p50: Number(at(0.5).toFixed(4)), p95: Number(at(0.95).toFixed(4)), p99: Number(at(0.99).toFixed(4)) }; }
function elapsed(started: number): number { return performance.now() - started; }
function node(id: string): FederationNodeInput { return { id, name: id, endpoint: `in-memory://${id}`, role: 'hybrid', capabilities: ['analysis', 'coding', 'testing', 'security', 'review'], status: 'healthy', trustLevel: 'TRUSTED' }; }
function routingTask(taskId: string, locality: FederationRoutingTask['locality'] = 'any'): FederationRoutingTask { return { taskId, requiredCapabilities: [taskId.endsWith('security') ? 'security' : taskId.endsWith('test') ? 'testing' : 'coding'], locality, securityContext: { subject: 'benchmark', permissions: ['federation:dispatch'], trustLevel: 'TRUSTED' }, authorizationContext: { subject: 'benchmark', trace: taskId } }; }

const registry = new NodeRegistry();
const network = new InMemoryFederationNetwork();
const signer = new HmacMessageSigner('m14-benchmark-key');
const coordinators = ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'].map((id) => new FederationCoordinator({ localNode: node(id), registry, network, signer, verifier: new HmacMessageVerifier('m14-benchmark-key') }));
const local = coordinators[0]!;
try {
  const registrationLatencies: number[] = [];
  for (let index = 0; index < 100; index += 1) { const started = performance.now(); registry.registerNode({ ...node(`registered-${index}`), status: 'joining' }); registrationLatencies.push(elapsed(started)); }
  const heartbeatLatencies: number[] = [];
  for (let index = 0; index < 100; index += 1) { const started = performance.now(); local.heartbeat('node-a'); heartbeatLatencies.push(elapsed(started)); }
  const verificationLatencies: number[] = [];
  for (let index = 0; index < 100; index += 1) { const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: { sequence: index } }, signer); const started = performance.now(); if (!new HmacMessageVerifier('m14-benchmark-key').verify(message)) throw new Error('benchmark message verification failed'); verificationLatencies.push(elapsed(started)); }
  const routingLatencies: number[] = [];
  for (let index = 0; index < 1_000; index += 1) { const started = performance.now(); local.route(routingTask(`route-${index}${index % 3 === 0 ? '-test' : ''}`)); routingLatencies.push(elapsed(started)); }
  const leaseManager = new DistributedLeaseManager({ defaultTtlMs: 30_000 });
  const leaseLatencies: number[] = [];
  for (let index = 0; index < 100; index += 1) { const started = performance.now(); const lease = leaseManager.acquire(`lease-task-${index}`, 'node-a'); if (!lease) throw new Error('benchmark lease acquisition failed'); leaseManager.release(lease.leaseId, lease.fencingToken); leaseLatencies.push(elapsed(started)); }
  const remoteDispatchLatencies: number[] = [];
  for (let index = 0; index < 20; index += 1) { const started = performance.now(); await local.dispatch({ ...routingTask(`remote-task-${index}`), nodeId: 'node-b' }); remoteDispatchLatencies.push(elapsed(started)); }
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let index = 0; index < 20; index += 1) await coordinators[1]!.complete(`remote-task-${index}`, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reassignmentStarted = performance.now();
  const localTask = await local.dispatch({ ...routingTask('reassign-task'), nodeId: 'node-a' });
  registry.markOffline('node-b');
  const reassigned = await local.handoff(localTask.taskId, 'node-c');
  const reassignmentMs = elapsed(reassignmentStarted);
  const schedulingStarted = performance.now();
  const scheduling = Array.from({ length: 100 }, (_, index) => local.route(routingTask(`agent-task-${index}`)));
  const schedulingMs = elapsed(schedulingStarted);
  const throughputStarted = performance.now();
  const throughputDecisions = Array.from({ length: 1_000 }, (_, index) => local.route(routingTask(`throughput-${index}${index % 2 === 0 ? '-security' : ''}`)));
  const throughputMs = elapsed(throughputStarted);
  const remoteMetrics = local.metrics();
  console.log(JSON.stringify({ benchmark: 'm14-federation', deterministic: true, nodeCount: 5, registeredAgents: 100, taskUnits: 1_000, latencyMs: { nodeRegistration: summary(registrationLatencies), heartbeat: summary(heartbeatLatencies), messageVerification: summary(verificationLatencies), routing: summary(routingLatencies), leaseAcquireRelease: summary(leaseLatencies), remoteDispatch: summary(remoteDispatchLatencies), reassignment: Number(reassignmentMs.toFixed(4)) }, scheduling: { decisions: scheduling.length, elapsedMs: Number(schedulingMs.toFixed(4)) }, throughput: { decisions: throughputDecisions.length, elapsedMs: Number(throughputMs.toFixed(4)), tasksPerSecond: Number((throughputDecisions.length / (throughputMs / 1_000)).toFixed(2)) }, reassignment: { taskId: reassigned.taskId, nodeId: reassigned.nodeId, status: reassigned.status }, metrics: remoteMetrics, limitations: ['in-memory transport used for deterministic tests', 'SQLite/file leases are replaceable stores and are not distributed consensus', 'no cloud or LLM calls'] }, null, 2));
} finally { await Promise.all(coordinators.map((coordinator) => coordinator.close())); }
