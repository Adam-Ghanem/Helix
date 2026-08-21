import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HelixRuntime, type ModelProvider } from '../packages/runtime/src/index.js';
import {
  DistributedLeaseManager,
  FaultInjectingTransport,
  FederationCoordinator,
  HmacMessageSigner,
  HmacMessageVerifier,
  InMemoryFederationNetwork,
  InMemoryFederationTransport,
  NodeRegistry,
  type FederationRoutingTask,
  type FederationTransport,
} from '../packages/federation/src/index.js';

const DEMO_KEY = 'm15-explicit-demo-key';
const KEY_ID = 'm15-demo-key';
const SECURITY = { subject: 'helix-demo', permissions: ['federation:dispatch'], trustLevel: 'TRUSTED' as const };
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function removeDirectory(directory: string): Promise<void> { for (let attempt = 0; attempt < 8; attempt += 1) { try { await rm(directory, { recursive: true, force: true }); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; await sleep(100); } } await rm(directory, { recursive: true, force: true }); }
function node(id: string, role: 'hybrid' | 'worker' = 'worker') { return { id, name: id, endpoint: `in-memory://${id}`, role, capabilities: ['analysis', 'coding', 'testing', 'review'], status: 'healthy' as const, trustLevel: role === 'hybrid' ? 'ADMIN' as const : 'TRUSTED' as const }; }
function task(taskId: string, nodeId?: string): FederationRoutingTask & { title: string; input: unknown } { return { taskId, ...(nodeId ? { nodeId } : {}), title: 'distributed demo analysis', input: { taskId }, requiredCapabilities: ['analysis'], locality: nodeId ? 'remote' : 'any', securityContext: SECURITY, authorizationContext: { sourceNodeId: 'node-a', demo: 'm15' } }; }
class DemoProvider implements ModelProvider {
  readonly name = 'm15-demo-provider';
  constructor(private readonly delayMs = 0) {}
  async execute(): Promise<{ output: unknown; tokens: number; costUsd: number; quality: number }> { if (this.delayMs) await sleep(this.delayMs); return { output: { demo: true }, tokens: 1, costUsd: 0, quality: 0.95 }; }
}
function summary(values: number[]) { const ordered = [...values].sort((a, b) => a - b); const at = (p: number) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))] ?? 0; return { count: ordered.length, p50Ms: Number(at(0.5).toFixed(3)), p95Ms: Number(at(0.95).toFixed(3)), p99Ms: Number(at(0.99).toFixed(3)) }; }
async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (!check()) { if (Date.now() >= deadline) throw new Error('demo bounded wait expired'); await sleep(5); } }

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-m15-demo-'));
  const network = new InMemoryFederationNetwork();
  const registry = new NodeRegistry();
  const signer = new HmacMessageSigner(DEMO_KEY, KEY_ID);
  const verifier = () => new HmacMessageVerifier(DEMO_KEY, undefined, 30_000, Date.now, KEY_ID);
  const transports: FederationTransport[] = [];
  const coordinators: FederationCoordinator[] = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `node-${String.fromCharCode(97 + index)}`;
    const base = new InMemoryFederationTransport(id, network);
    const transport = index === 0 ? new FaultInjectingTransport(base, [{ action: 'delay', messageType: 'task.submit', delayMs: 15, remaining: 1 }, { action: 'crash', messageType: 'task.submit', remaining: 1 }]) : base;
    transports.push(transport);
    coordinators.push(new FederationCoordinator({ localNode: node(id, index === 0 ? 'hybrid' : 'worker'), registry, transport, signer, verifier: verifier() }));
  }
  const runtimes = [0, 1, 2, 3, 4].map((index) => new HelixRuntime({ dataDirectory: join(directory, `runtime-${index}`), provider: index === 1 ? new DemoProvider(80) : new DemoProvider(), learningAsync: false, federation: coordinators[index]!, federationRuntime: { heartbeatIntervalMs: 25, drainDeadlineMs: 500, executionTimeoutMs: 250 } }));
  const metrics: Record<string, unknown> = { demo: 'helix-distributed-runtime-m15', nodes: 5, agents: 100, tasks: 1_000, forcedFailures: ['network delay', 'injected node crash', 'lease expiration', 'remote cancellation', 'invalid sandbox execution'], latencyMs: {} };
  try {
    await Promise.all(runtimes.map((runtime) => runtime.init())); await Promise.all(runtimes.map((runtime) => runtime.startFederationRuntime()));
    const forcedDelay = await coordinators[0]!.dispatch(task('demo-injected-delay', 'node-b')).then(() => ({ status: 'delivered' })).catch((error: unknown) => ({ status: 'caught', error: error instanceof Error ? error.message : String(error) }));
    const forcedCrash = await coordinators[0]!.dispatch(task('demo-injected-crash', 'node-b')).then(() => ({ status: 'unexpected-success' })).catch((error: unknown) => ({ status: 'caught', error: error instanceof Error ? error.message : String(error) }));
    const executionLatencies: number[] = [];
    for (let index = 0; index < 20; index += 1) { const started = performance.now(); const record = await coordinators[0]!.dispatch(task(`demo-execution-${index}`, 'node-c')); await eventually(() => ['completed', 'failed'].includes(coordinators[0]!.getTask(record.taskId).status)); executionLatencies.push(performance.now() - started); }
    (metrics.latencyMs as Record<string, unknown>).remoteExecution = summary(executionLatencies);

    const invalidSandbox = await coordinators[0]!.dispatch({ ...task('demo-invalid-sandbox', 'node-c'), sandbox: { enabled: true, command: { command: '/definitely/not-allowed' } } });
    await eventually(() => ['completed', 'failed', 'cancelled'].includes(coordinators[0]!.getTask(invalidSandbox.taskId).status));
    const failure = coordinators[0]!.getTask(invalidSandbox.taskId);
    const slow = await coordinators[0]!.dispatch(task('demo-cancel', 'node-b')); await sleep(10); await coordinators[0]!.cancel(slow.taskId); await eventually(() => ['cancelled', 'completed', 'failed'].includes(coordinators[0]!.getTask(slow.taskId).status));
    const reassignment = await coordinators[0]!.handoff('demo-execution-0', 'node-d');
    let leaseClock = 10_000; const leaseManager = new DistributedLeaseManager({ defaultTtlMs: 5, clock: () => leaseClock }); const lease = leaseManager.acquire('demo-expiring-lease', 'node-b')!; leaseClock += 10; const expired = leaseManager.expire();
    metrics.failures = { injectedDelay: forcedDelay, injectedCrash: forcedCrash, invalidSandboxDispatch: failure, cancelledTask: coordinators[0]!.getTask(slow.taskId).status, reassignment: { nodeId: reassignment.nodeId, status: reassignment.status }, leaseExpiration: { leaseId: lease.leaseId, expired: expired.length } };

    const simulationRegistry = new NodeRegistry(); const simulationNetwork = new InMemoryFederationNetwork(); const simulation: FederationCoordinator[] = [];
    for (let index = 0; index < 5; index += 1) { const id = `sim-${String.fromCharCode(97 + index)}`; simulation.push(new FederationCoordinator({ localNode: node(id, index === 0 ? 'hybrid' : 'worker'), registry: simulationRegistry, network: simulationNetwork, signer, verifier: verifier() })); }
    const agentStarted = performance.now(); for (let index = 0; index < 100; index += 1) simulation[0]!.route(task(`demo-agent-${index}`)); const agentMs = performance.now() - agentStarted;
    const taskStarted = performance.now(); const dispatched = await Promise.all(Array.from({ length: 1_000 }, (_, index) => simulation[0]!.dispatch(task(`demo-task-${index}`, `sim-${String.fromCharCode(98 + (index % 4))}`)))); const taskMs = performance.now() - taskStarted;
    (metrics.simulation = { nodes: 5, agents: 100, agentRouting: { decisions: 100, elapsedMs: Number(agentMs.toFixed(3)) }, tasks: { dispatched: dispatched.length, elapsedMs: Number(taskMs.toFixed(3)), tasksPerSecond: Number((dispatched.length / (taskMs / 1_000)).toFixed(2)) }, note: 'The 1,000-task run is a bounded authenticated dispatch simulation; the execution sample above invokes real HelixRuntime workers.' });
    await sleep(100);
    await Promise.all(simulation.map((coordinator) => coordinator.close()));
    console.log(JSON.stringify({ ...metrics, limitations: ['HMAC and in-memory transport are explicit demo fixtures', 'SQLite outbox and leases are local durability mechanisms, not distributed consensus', 'no Byzantine fault tolerance or consensus claim', 'the 1,000-task simulation measures dispatch throughput; 20 tasks exercise the full remote worker path'] }, null, 2));
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.stopFederationRuntime().catch(() => undefined)));
    await Promise.all(coordinators.map((coordinator) => coordinator.close().catch(() => undefined)));
    await removeDirectory(directory);
  }
}
void main();
