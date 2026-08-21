import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import {
  DistributedLeaseManager,
  FederationCoordinator,
  HmacMessageSigner,
  HmacMessageVerifier,
  InMemoryFederationNetwork,
  InMemoryFederationTransport,
  NodeRegistry,
  SqliteOutboxStore,
  createFederationMessage,
  type FederationRoutingTask,
} from '../packages/federation/src/index.js';

const secret = 'm15-explicit-benchmark-key';
const keyId = 'm15-benchmark-key';
const securityContext = { subject: 'benchmark', permissions: ['federation:dispatch'], trustLevel: 'TRUSTED' as const };
function node(id: string, role: 'hybrid' | 'worker' = 'worker') { return { id, name: id, endpoint: `in-memory://${id}`, role, capabilities: ['analysis', 'coding', 'testing', 'review'], status: 'healthy' as const, trustLevel: role === 'hybrid' ? 'ADMIN' as const : 'TRUSTED' as const }; }
function routingTask(taskId: string, nodeId?: string): FederationRoutingTask & { title: string; input: unknown } { return { taskId, ...(nodeId ? { nodeId } : {}), title: 'benchmark analysis', input: { taskId }, requiredCapabilities: ['analysis'], locality: nodeId ? 'remote' : 'any', securityContext, authorizationContext: { sourceNodeId: 'node-a', benchmark: 'm15' } }; }
function summary(values: number[]) { const ordered = [...values].sort((a, b) => a - b); const percentile = (p: number) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))] ?? 0; return { count: ordered.length, p50: Number(percentile(0.50).toFixed(4)), p95: Number(percentile(0.95).toFixed(4)), p99: Number(percentile(0.99).toFixed(4)), min: Number((ordered[0] ?? 0).toFixed(4)), max: Number((ordered.at(-1) ?? 0).toFixed(4)) }; }
function elapsed(started: number): number { return performance.now() - started; }
async function eventually(check: () => boolean, timeoutMs: number): Promise<void> { const deadline = Date.now() + timeoutMs; while (!check()) { if (Date.now() >= deadline) throw new Error('benchmark completion timeout'); await new Promise((resolve) => setTimeout(resolve, 2)); } }

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-m15-benchmark-'));
  const network = new InMemoryFederationNetwork();
  const registry = new NodeRegistry();
  const signer = new HmacMessageSigner(secret, keyId);
  const verifier = () => new HmacMessageVerifier(secret, undefined, 30_000, Date.now, keyId);
  const coordinators = ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'].map((id, index) => new FederationCoordinator({ localNode: node(id, index === 0 ? 'hybrid' : 'worker'), registry, transport: new InMemoryFederationTransport(id, network), signer, verifier: verifier() }));
  const local = coordinators[0]!;
  const result: Record<string, unknown> = { benchmark: 'm15-distributed-runtime', deterministic: true, nodeCount: 5, agentSimulationCount: 100, taskSimulationCount: 1_000, latencyMs: {} };
  try {
    const transportLatencies: number[] = [];
    for (let index = 0; index < 200; index += 1) { const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: { index } }, signer); const started = performance.now(); await local.transport.send(message); transportLatencies.push(elapsed(started)); }
    (result.latencyMs as Record<string, unknown>).transportSend = summary(transportLatencies);

    const verificationLatencies: number[] = [];
    for (let index = 0; index < 500; index += 1) { const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: { index } }, signer); const started = performance.now(); if (!verifier().verify(message)) throw new Error('benchmark signature verification failed'); verificationLatencies.push(elapsed(started)); }
    (result.latencyMs as Record<string, unknown>).messageVerification = summary(verificationLatencies);

    const outboxPath = join(directory, 'federation.sqlite');
    const outbox = new SqliteOutboxStore(outboxPath);
    const enqueueLatencies: number[] = [];
    for (let index = 0; index < 200; index += 1) { const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: { index } }, signer); const started = performance.now(); outbox.enqueue({ messageId: message.messageId, destination: 'node-b', payload: message, idempotencyKey: `m15-outbox-${index}` }); enqueueLatencies.push(elapsed(started)); }
    const recoveryStarted = performance.now(); const claimed = outbox.claim(200); const recoveryMs = elapsed(recoveryStarted); outbox.close();
    (result.latencyMs as Record<string, unknown>).outboxEnqueue = summary(enqueueLatencies);
    (result.latencyMs as Record<string, unknown>).outboxRecovery = { records: claimed.length, elapsedMs: Number(recoveryMs.toFixed(4)) };

    const leaseManager = new DistributedLeaseManager({ defaultTtlMs: 30_000 });
    const leaseLatencies: number[] = [];
    for (let index = 0; index < 500; index += 1) { const started = performance.now(); const lease = leaseManager.acquire(`m15-lease-${index}`, 'node-a'); if (!lease) throw new Error('lease acquisition failed'); leaseManager.release(lease.leaseId, lease.fencingToken); leaseLatencies.push(elapsed(started)); }
    (result.latencyMs as Record<string, unknown>).leaseAcquireRelease = summary(leaseLatencies);

    const runtimeA = new HelixRuntime({ dataDirectory: join(directory, 'runtime-a'), learningAsync: false, federation: coordinators[0]!, federationRuntime: { heartbeatIntervalMs: 25, drainDeadlineMs: 1_000, executionTimeoutMs: 1_000 } });
    const runtimeB = new HelixRuntime({ dataDirectory: join(directory, 'runtime-b'), learningAsync: false, federation: coordinators[1]!, federationRuntime: { heartbeatIntervalMs: 25, drainDeadlineMs: 1_000, executionTimeoutMs: 1_000 } });
    await runtimeA.init(); await runtimeB.init(); await runtimeA.startFederationRuntime(); await runtimeB.startFederationRuntime();
    const executionLatencies: number[] = [];
    for (let index = 0; index < 20; index += 1) { const started = performance.now(); const record = await local.dispatch(routingTask(`m15-exec-${index}`, 'node-b')); await eventually(() => local.getTask(record.taskId).status === 'completed', 5_000); executionLatencies.push(elapsed(started)); }
    (result.latencyMs as Record<string, unknown>).remoteExecution = summary(executionLatencies);
    await runtimeA.stopFederationRuntime(); await runtimeB.stopFederationRuntime();
    registry.heartbeat('node-a'); registry.heartbeat('node-b'); registry.heartbeat('node-c'); registry.heartbeat('node-d'); registry.heartbeat('node-e');

    const retryLatencies: number[] = [];
    const retryPath = join(directory, 'retry.sqlite');
    const retryStore = new SqliteOutboxStore(retryPath);
    for (let index = 0; index < 100; index += 1) { const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', payload: { index } }, signer); const record = retryStore.enqueue({ messageId: message.messageId, destination: 'node-b', payload: message, idempotencyKey: `m15-retry-${index}` }); const started = performance.now(); retryStore.retry(record.id, 'temporary', Date.now()); retryLatencies.push(elapsed(started)); }
    retryStore.close(); (result.latencyMs as Record<string, unknown>).retryOverhead = summary(retryLatencies);

    const reassignmentLatencies: number[] = [];
    for (let index = 0; index < 100; index += 1) { const record = await local.dispatch({ ...routingTask(`m15-reassign-${index}`, 'node-a'), locality: 'local' }); const started = performance.now(); const moved = await local.handoff(record.taskId, index % 2 === 0 ? 'node-c' : 'node-d'); if (moved.nodeId === record.nodeId) throw new Error('reassignment did not move task'); reassignmentLatencies.push(elapsed(started)); }
    (result.latencyMs as Record<string, unknown>).reassignment = summary(reassignmentLatencies);

    const agentThroughputStarted = performance.now(); const agentDecisions = Array.from({ length: 100 }, (_, index) => local.route(routingTask(`m15-agent-${index}`))); const agentThroughputMs = elapsed(agentThroughputStarted);
    (result as Record<string, unknown>).agentThroughput = { simulatedAgents: 100, decisions: agentDecisions.length, elapsedMs: Number(agentThroughputMs.toFixed(4)), agentsPerSecond: Number((100 / (agentThroughputMs / 1_000)).toFixed(2)) };

    const completionCoordinator = new FederationCoordinator({ localNode: node('node-e'), registry, transport: new InMemoryFederationTransport('node-e', network), signer, verifier: verifier() });
    completionCoordinator.setTaskHandler(async (payload) => { await completionCoordinator.complete(String(payload.taskId), true, undefined, { completed: true }); });
    const completionStarted = performance.now(); const completionRecords = await Promise.all(Array.from({ length: 1_000 }, (_, index) => local.dispatch(routingTask(`m15-completion-${index}`, 'node-e')))); await eventually(() => completionRecords.every((record) => local.getTask(record.taskId).status === 'completed'), 30_000); const completionMs = elapsed(completionStarted);
    (result as Record<string, unknown>).taskCompletionThroughput = { tasks: completionRecords.length, elapsedMs: Number(completionMs.toFixed(4)), tasksPerSecond: Number((completionRecords.length / (completionMs / 1_000)).toFixed(2)), p50CompletionDispatchMs: summary(completionRecords.map(() => completionMs / completionRecords.length)).p50 };
    await completionCoordinator.close();
    console.log(JSON.stringify({ ...result, limitations: ['deterministic in-memory transport and explicit test keys used', '1,000-task completion measures coordinator completion throughput; only the remote-execution sample invokes HelixRuntime workers', 'SQLite outbox and lease stores are durable local infrastructure, not distributed consensus', 'no Byzantine fault tolerance, consensus, cloud LLM, or production network claim'] }, null, 2));
  } finally {
    await Promise.all(coordinators.map((coordinator) => coordinator.close().catch(() => undefined)));
    await rm(directory, { recursive: true, force: true });
  }
}
void main();
