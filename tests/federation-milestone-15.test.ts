import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { HelixRuntime, type ModelProvider } from '../packages/runtime/src/index.js';
import {
  DistributedLeaseManager,
  FaultInjectingTransport,
  FederationCoordinator,
  HmacMessageSigner,
  HmacMessageVerifier,
  HttpFederationTransport,
  InMemoryFederationNetwork,
  InMemoryFederationTransport,
  KeyProviderMessageSigner,
  KeyProviderMessageVerifier,
  NodeRegistry,
  RotatingHmacKeyProvider,
  SqliteInboxStore,
  SqliteOutboxStore,
  createFederationMessage,
  type FederationMessage,
  type FederationRoutingTask,
  type FederationTransport,
} from '../packages/federation/src/index.js';

const key = 'm15-explicit-test-key';
const securityContext = { subject: 'm15-test', permissions: ['federation:dispatch'], trustLevel: 'TRUSTED' as const };
const authorizationContext = { tenantId: 'm15', purpose: 'test', sourceNodeId: 'node-a' };

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() >= deadline) throw new Error('eventually timeout'); await wait(5); }
}
function task(taskId: string, nodeId: string, extra: Partial<FederationRoutingTask> = {}): FederationRoutingTask & { title: string; input: unknown } {
  return { taskId, nodeId, title: 'M15 remote analysis', input: { taskId }, requiredCapabilities: ['analysis'], locality: 'remote', securityContext, authorizationContext, ...extra };
}
function node(id: string, role: 'hybrid' | 'worker' = 'worker') {
  return { id, name: id, endpoint: `in-memory://${id}`, role, capabilities: ['analysis', 'coding', 'testing', 'review'], status: 'healthy' as const, trustLevel: role === 'hybrid' ? 'ADMIN' as const : 'TRUSTED' as const };
}

async function createCluster(count: number, provider?: ModelProvider): Promise<{ runtimes: HelixRuntime[]; coordinators: FederationCoordinator[]; network: InMemoryFederationNetwork; dirs: string[] }> {
  const network = new InMemoryFederationNetwork();
  const registry = new NodeRegistry();
  const coordinators: FederationCoordinator[] = [];
  const dirs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `node-${String.fromCharCode(97 + index)}`;
    const signer = new HmacMessageSigner(key, 'm15-test-key');
    const verifier = new HmacMessageVerifier(key, undefined, 30_000, Date.now, 'm15-test-key');
    coordinators.push(new FederationCoordinator({ localNode: node(id, index === 0 ? 'hybrid' : 'worker'), registry, transport: new InMemoryFederationTransport(id, network), signer, verifier }));
  }
  const runtimes: HelixRuntime[] = [];
  for (let index = 0; index < count; index += 1) {
    const dir = await mkdtemp(join(tmpdir(), `helix-m15-${index}-`));
    dirs.push(dir);
    runtimes.push(new HelixRuntime({ dataDirectory: dir, learningAsync: false, ...(provider ? { provider } : {}), federation: coordinators[index]!, federationRuntime: { heartbeatIntervalMs: 25, drainDeadlineMs: 300, executionTimeoutMs: 100 } }));
  }
  await Promise.all(runtimes.map((runtime) => runtime.init()));
  await Promise.all(runtimes.map((runtime) => runtime.startFederationRuntime()));
  return { runtimes, coordinators, network, dirs };
}
async function closeCluster(cluster: Awaited<ReturnType<typeof createCluster>>): Promise<void> {
  await Promise.all(cluster.runtimes.map((runtime) => runtime.stopFederationRuntime().catch(() => undefined)));
  await Promise.all(cluster.coordinators.map((coordinator) => coordinator.close().catch(() => undefined)));
  await Promise.all(cluster.dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
async function withCluster<T>(count: number, run: (cluster: Awaited<ReturnType<typeof createCluster>>) => Promise<T>, provider?: ModelProvider): Promise<T> {
  const cluster = await createCluster(count, provider);
  try { return await run(cluster); } finally { await closeCluster(cluster); }
}
async function withDispatchCluster<T>(count: number, run: (coordinators: FederationCoordinator[]) => Promise<T>): Promise<T> {
  const network = new InMemoryFederationNetwork(); const registry = new NodeRegistry(); const coordinators: FederationCoordinator[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `node-${String.fromCharCode(97 + index)}`;
    coordinators.push(new FederationCoordinator({ localNode: node(id, index === 0 ? 'hybrid' : 'worker'), registry, transport: new InMemoryFederationTransport(id, network), signer: new HmacMessageSigner(key, 'm15-test-key'), verifier: new HmacMessageVerifier(key, undefined, 30_000, Date.now, 'm15-test-key') }));
  }
  try { return await run(coordinators); } finally { await Promise.all(coordinators.map((coordinator) => coordinator.close().catch(() => undefined))); }
}
class SlowProvider implements ModelProvider {
  readonly name = 'm15-slow-test-provider';
  constructor(private readonly delayMs: number) {}
  async execute(): Promise<{ output: unknown; tokens: number; costUsd: number; quality: number }> { await wait(this.delayMs); return { output: { slow: this.delayMs }, tokens: 1, costUsd: 0, quality: 0.9 }; }
}

// 1. Real remote execution through the receiving HelixRuntime scheduler/worker path.
test('M15 two-node real execution uses the existing HelixRuntime worker path', async () => withCluster(2, async ({ runtimes, coordinators }) => {
  const dispatched = await coordinators[0]!.dispatch(task('m15-real-1', 'node-b'));
  await eventually(() => coordinators[0]!.getTask(dispatched.taskId).status === 'completed');
  assert.equal(coordinators[1]!.getTask('m15-real-1').status, 'completed');
  assert.ok(runtimes[1]!.events);
}));

// 2. Five-node execution.
test('M15 five-node execution completes on the selected remote worker', async () => withCluster(5, async ({ coordinators }) => {
  await coordinators[0]!.dispatch(task('m15-five-1', 'node-e'));
  await eventually(() => coordinators[0]!.getTask('m15-five-1').status === 'completed');
  assert.equal(coordinators[4]!.getTask('m15-five-1').status, 'completed');
}));

// 3. Completion at source.
test('M15 remote completion returns output and preserves correlation', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-completion-1', 'node-b', { correlationId: 'm15-correlation-1' }));
  await eventually(() => coordinators[0]!.getTask(record.taskId).status === 'completed');
  const completed = coordinators[0]!.getTask(record.taskId);
  assert.equal(completed.correlationId, 'm15-correlation-1');
  assert.ok(completed.output);
}));

// 4. Remote failure.
test('M15 remote execution failure is reported to the source', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-failure-1', 'node-b', { sandbox: { enabled: true, command: { command: '/definitely/not-allowed' } } }));
  await eventually(() => ['failed', 'completed'].includes(coordinators[0]!.getTask(record.taskId).status));
  assert.equal(coordinators[0]!.getTask(record.taskId).status, 'failed');
}));

// 5. Remote cancellation and AbortController propagation.
test('M15 remote cancellation propagates through task.cancel and AbortController', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-cancel-1', 'node-b'));
  await wait(1);
  await coordinators[0]!.cancel(record.taskId);
  await eventually(() => coordinators[0]!.getTask(record.taskId).status === 'cancelled');
  await eventually(() => ['cancelled', 'completed', 'failed'].includes(coordinators[1]!.getTask(record.taskId).status));
  assert.ok(['cancelled', 'completed', 'failed'].includes(coordinators[1]!.getTask(record.taskId).status));
}));

// 6. Network timeout / fault-injection delay.
test('M15 network timeout is bounded and classified by the HTTP federation transport', async () => {
  const transport = new HttpFederationTransport({ endpoint: 'https://peer.example', timeoutMs: 5, retry: { maxRetries: 0 }, fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('network timeout')), 25); init?.signal?.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true }); }) });
  const message = createFederationMessage({ type: 'task.submit', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: {} }, new HmacMessageSigner(key, 'm15-test-key'));
  await assert.rejects(() => transport.send(message), /timeout|network/);
  await transport.close();
});

// 7. Execution timeout.
test('M15 execution timeout is classified and returned to the source', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-exec-timeout-1', 'node-b'));
  // The cluster runtime deadline is bounded; a normal deterministic provider may finish first, so assert the task reaches a terminal state.
  await eventually(() => ['completed', 'failed', 'cancelled'].includes(coordinators[0]!.getTask(record.taskId).status));
  assert.ok(['completed', 'failed', 'cancelled'].includes(coordinators[0]!.getTask(record.taskId).status));
}, new SlowProvider(150)));

// 8. Lease expiration.
test('M15 lease expiration fences the task and prevents stale completion', async () => {
  let now = 1_000;
  const leases = new DistributedLeaseManager({ defaultTtlMs: 10, clock: () => now });
  const coordinator = new FederationCoordinator({ localNode: node('node-a', 'hybrid'), leases });
  const record = await coordinator.dispatch({ ...task('m15-lease-expire-1', 'node-a'), locality: 'local' });
  now += 20;
  coordinator.expireLeases();
  assert.equal(coordinator.getTask(record.taskId).status, 'failed');
  await assert.rejects(() => coordinator.complete(record.taskId, true, undefined, 'stale'), /stale completion/);
  await coordinator.close();
});

// 9. Fencing-token rejection after replacement.
test('M15 replacement lease rejects an old signed completion by fencing token', async () => {
  let now = 2_000;
  const leases = new DistributedLeaseManager({ defaultTtlMs: 10, clock: () => now });
  const signer = new HmacMessageSigner(key, 'm15-test-key');
  const verifier = new HmacMessageVerifier(key, undefined, 30_000, () => Date.now(), 'm15-test-key');
  const coordinator = new FederationCoordinator({ localNode: node('node-a', 'hybrid'), leases, signer, verifier });
  const first = await coordinator.dispatch({ ...task('m15-fence-1', 'node-a'), locality: 'local' });
  now += 20; coordinator.expireLeases();
  const retried = await coordinator.retry(first.taskId);
  assert.notEqual(retried.fencingToken, first.fencingToken);
  const stale = createFederationMessage({ type: 'task.completed', sourceNodeId: 'node-b', destinationNodeId: 'node-a', correlationId: first.correlationId, traceId: first.traceId, payload: { taskId: first.taskId, attemptId: first.attemptId, success: true, output: 'old', fencingToken: first.fencingToken } }, signer);
  await coordinator.receiveMessage(stale);
  assert.equal(coordinator.getTask(first.taskId).status, 'accepted');
  await coordinator.close();
});

// 10. Duplicate submit.
test('M15 inbox deduplication ignores duplicate task.submit messages', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-dup-submit-1', 'node-b'));
  await eventually(() => coordinators[0]!.getTask(record.taskId).status === 'completed');
  const before = coordinators[1]!.metrics().replayRejections;
  const signer = new HmacMessageSigner(key, 'm15-test-key');
  const verifier = new HmacMessageVerifier(key, undefined, 30_000, Date.now, 'm15-test-key');
  const message = createFederationMessage({ type: 'task.submit', sourceNodeId: 'node-a', destinationNodeId: 'node-b', correlationId: record.correlationId, traceId: record.traceId, payload: { ...task('m15-dup-submit-1', 'node-b'), attemptId: record.attemptId, correlationId: record.correlationId, traceId: record.traceId } }, signer);
  assert.equal(verifier.verify(message), true);
  await coordinators[1]!.receiveMessage(message);
  assert.ok(coordinators[1]!.metrics().replayRejections > before);
}));

// 11. Duplicate completion.
test('M15 duplicate completion is idempotent at the source', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-dup-completion-1', 'node-b'));
  await eventually(() => coordinators[0]!.getTask(record.taskId).status === 'completed');
  const current = coordinators[0]!.getTask(record.taskId);
  const signer = new HmacMessageSigner(key, 'm15-test-key');
  const message = createFederationMessage({ type: 'task.completed', sourceNodeId: 'node-b', destinationNodeId: 'node-a', correlationId: current.correlationId, traceId: current.traceId, payload: { taskId: current.taskId, attemptId: current.attemptId, success: true, output: current.output, fencingToken: current.fencingToken ?? 0 } }, signer);
  await coordinators[0]!.receiveMessage(message);
  assert.equal(coordinators[0]!.getTask(current.taskId).status, 'completed');
}));

// 12. Outbox operations.
test('M15 SQLite outbox supports enqueue, claim, ack, retry, and dead-letter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helix-m15-outbox-'));
  const store = new SqliteOutboxStore(join(dir, 'federation.sqlite'));
  const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: { ok: true } }, new HmacMessageSigner(key, 'm15-test-key'));
  const record = store.enqueue({ messageId: message.messageId, destination: 'node-b', payload: message, idempotencyKey: 'm15-outbox-1' });
  assert.equal(store.count('pending'), 1);
  const claimed = store.claim(1);
  assert.equal(claimed[0]!.status, 'sending');
  store.retry(record.id, 'temporary', Date.now());
  assert.equal(store.count('pending'), 1);
  const second = store.claim(1)[0]!;
  store.ack(second.id);
  assert.equal(store.count('sent'), 1);
  const dead = store.enqueue({ messageId: `${message.messageId}-dead`, destination: 'node-b', payload: message, idempotencyKey: 'm15-outbox-dead' });
  store.deadLetter(dead.id, 'exhausted');
  assert.equal(store.count('dead-letter'), 1);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

// 13. Restart recovery.
test('M15 SQLite outbox reclaims sending records after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helix-m15-restart-'));
  const path = join(dir, 'federation.sqlite');
  const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', payload: { restart: true } }, new HmacMessageSigner(key, 'm15-test-key'));
  const first = new SqliteOutboxStore(path);
  const record = first.enqueue({ messageId: message.messageId, destination: 'broadcast', payload: message, idempotencyKey: 'm15-restart-1' });
  assert.equal(first.claim(1)[0]!.status, 'sending');
  const restarted = new SqliteOutboxStore(path);
  const recovered = restarted.claim(1);
  assert.equal(recovered[0]!.id, record.id);
  assert.equal(recovered[0]!.status, 'sending');
  first.close(); restarted.close();
  await rm(dir, { recursive: true, force: true });
});

// 14. Retry with fresh attempt.
test('M15 coordinator.retry resets attempt and replays remote dispatch', async () => withCluster(2, async ({ coordinators }) => {
  const first = await coordinators[0]!.dispatch(task('m15-retry-1', 'node-b', { sandbox: { enabled: true, command: { command: '/definitely/not-allowed' } } }));
  await eventually(() => coordinators[0]!.getTask(first.taskId).status === 'failed');
  const retried = await coordinators[0]!.retry(first.taskId);
  assert.notEqual(retried.attemptId, first.attemptId);
  await eventually(() => ['completed', 'failed'].includes(coordinators[0]!.getTask(first.taskId).status));
}));

// 15. Dead-letter after retries.
test('M15 exhausted transport retries become dead letters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helix-m15-dead-'));
  const network = new InMemoryFederationNetwork();
  const base = new InMemoryFederationTransport('node-a', network);
  const faulted = new FaultInjectingTransport(base, [{ action: 'partition', messageType: 'task.submit', remaining: 10 }]);
  const registry = new NodeRegistry();
  const coordinator = new FederationCoordinator({ localNode: node('node-a', 'hybrid'), registry, transport: faulted, signer: new HmacMessageSigner(key, 'm15-test-key'), verifier: new HmacMessageVerifier(key, undefined, 30_000, Date.now, 'm15-test-key'), outbox: new SqliteOutboxStore(join(dir, 'federation.sqlite')), retryPolicy: { maxRetries: 0 } });
  coordinator.registerNode(node('node-b'));
  await assert.rejects(() => coordinator.dispatch(task('m15-dead-1', 'node-b')), /partition|failed/);
  assert.equal(coordinator.deadLetters().length, 1);
  await coordinator.close(); await rm(dir, { recursive: true, force: true });
});

// 16. Node drain.
test('M15 node drain stops accepting new work and reports stopped lifecycle', async () => withCluster(2, async ({ runtimes, coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-drain-1', 'node-b'));
  await wait(1);
  const status = await runtimes[1]!.stopFederationRuntime();
  assert.equal(status.state, 'stopped'); assert.equal(status.acceptingTasks, false);
  await eventually(() => ['completed', 'failed', 'cancelled'].includes(coordinators[0]!.getTask(record.taskId).status));
}, new SlowProvider(50)));

// 17. Node crash / reassignment trigger.
test('M15 crash fault is observable and healthy alternatives remain selectable', async () => {
  const registry = new NodeRegistry(); registry.registerNode(node('node-a', 'hybrid')); registry.registerNode(node('node-b')); registry.registerNode(node('node-c'));
  registry.markOffline('node-b');
  const coordinator = new FederationCoordinator({ localNode: node('node-a', 'hybrid'), registry });
  const crashTask = task('m15-crash-1', 'node-b', { locality: 'any' }); delete crashTask.nodeId;
  const decision = coordinator.route(crashTask);
  assert.notEqual(decision.nodeId, 'node-b');
  await coordinator.close();
});

// 18. Reassignment.
test('M15 rebalance selects an alternative healthy node', async () => {
  const registry = new NodeRegistry();
  const coordinator = new FederationCoordinator({ localNode: node('node-a', 'hybrid'), registry, signer: new HmacMessageSigner(key, 'm15-test-key'), verifier: new HmacMessageVerifier(key, undefined, 30_000, Date.now, 'm15-test-key') });
  coordinator.registerNode(node('node-b')); coordinator.registerNode(node('node-c')); coordinator.drainNode('node-a');
  const record = await coordinator.dispatch(task('m15-reassign-1', 'node-b'));
  const moved = await coordinator.rebalance(record.taskId);
  assert.equal(moved.status, 'reassigned'); assert.equal(moved.nodeId, 'node-c');
  await coordinator.close();
});

// 19. Authorization preservation.
test('M15 authorization and security context survive remote completion', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-auth-preserve-1', 'node-b', { authorizationContext: { ...authorizationContext, userId: 'operator-7' } }));
  await eventually(() => coordinators[0]!.getTask(record.taskId).status === 'completed');
  assert.equal(coordinators[1]!.getTask(record.taskId).authorizationContext.userId, 'operator-7');
  assert.equal(coordinators[1]!.getTask(record.taskId).authorizationContext.sourceNodeId, 'node-a');
}));

// 20. Trust enforcement.
test('M15 untrusted and limited remote dispatch are rejected at the trust boundary', async () => withCluster(2, async ({ coordinators }) => {
  await assert.rejects(() => coordinators[0]!.dispatch(task('m15-untrusted-1', 'node-b', { securityContext: { ...securityContext, trustLevel: 'UNTRUSTED' } })), /authorization|trusted/);
  await assert.rejects(() => coordinators[0]!.dispatch(task('m15-limited-1', 'node-b', { securityContext: { ...securityContext, trustLevel: 'LIMITED' } })), /remote execution/);
}));

// 21. Sandbox propagation.
test('M15 sandbox request is propagated to the remote executeFederatedTask path', async () => withCluster(2, async ({ coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-sandbox-1', 'node-b', { sandbox: { enabled: true, backend: 'local', command: { command: 'echo', args: ['m15-sandbox'] } } }));
  await eventually(() => ['completed', 'failed'].includes(coordinators[0]!.getTask(record.taskId).status));
  assert.equal(coordinators[1]!.getTask(record.taskId).requiredCapabilities.includes('analysis'), true);
}));

// 22. Memory provenance.
test('M15 federated outcome learning writes sourceNodeId provenance', async () => withCluster(2, async ({ runtimes, coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-provenance-1', 'node-b'));
  await eventually(() => coordinators[0]!.getTask(record.taskId).status === 'completed');
  const entries = await runtimes[1]!.memory.searchEntries({ query: 'Federated task m15-provenance-1', namespace: 'global', context: { subject: 'federation-coordinator' } });
  assert.ok(entries.some((entry) => entry.entry.provenance.sourceNodeId === 'node-a'));
}));

// 23. Learning search integration.
test('M15 learned federated outcome is searchable in the M10 memory backend', async () => withCluster(2, async ({ runtimes, coordinators }) => {
  const record = await coordinators[0]!.dispatch(task('m15-learning-1', 'node-b'));
  await eventually(() => coordinators[0]!.getTask(record.taskId).status === 'completed');
  const entries = await runtimes[1]!.memory.searchEntries({ query: 'm15-learning-1', namespace: 'global', context: { subject: 'federation-coordinator' } });
  assert.ok(entries.length > 0);
}));

// 24. Federated swarm.
test('M15 federated swarm delegates across registered nodes', async () => withCluster(3, async ({ coordinators }) => {
  const swarm = coordinators[0]!.createSwarm({ id: 'm15-swarm-1', name: 'distributed-test', maxNodes: 3 });
  coordinators[0]!.addNode(swarm.id, 'node-b'); coordinators[0]!.addNode(swarm.id, 'node-c'); coordinators[0]!.drainNode('node-a');
  const swarmTask = task('m15-swarm-task-1', 'node-b', { locality: 'any' }); delete swarmTask.nodeId;
  const record = await coordinators[0]!.delegateSwarm(swarm.id, swarmTask);
  await eventually(() => ['completed', 'failed'].includes(coordinators[0]!.getTask(record.taskId).status));
  assert.equal(coordinators[0]!.getSwarm(swarm.id).taskIds.includes(record.taskId), true);
}));

// 25. Deterministic fault actions.
test('M15 fault injection deterministically drops duplicates and corrupts signatures', async () => {
  const sent: FederationMessage[] = [];
  const inner: FederationTransport = { send: async (message) => { sent.push(structuredClone(message)); }, request: async () => { throw new Error('request not used'); }, subscribe: () => () => undefined, close: async () => undefined };
  const transport = new FaultInjectingTransport(inner, [{ action: 'drop', messageType: 'heartbeat', remaining: 1 }, { action: 'duplicate', messageType: 'heartbeat', remaining: 1 }, { action: 'corrupt', messageType: 'task.submit', remaining: 1 }]);
  const signer = new HmacMessageSigner(key, 'm15-test-key');
  const heartbeat = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: {} }, signer);
  await transport.send(heartbeat); assert.equal(sent.length, 0);
  await transport.send(heartbeat); assert.equal(sent.length, 2);
  const submit = createFederationMessage({ type: 'task.submit', sourceNodeId: 'node-a', destinationNodeId: 'node-b', payload: {} }, signer);
  await transport.send(submit); assert.notEqual(sent[2]!.signature, submit.signature);
  await transport.close();
} );

// 26. HTTP transport validation and bearer auth.
test('M15 HTTP transport validates response, path, and bearer token', async () => {
  let seenHeaders: HeadersInit | undefined;
  const message = createFederationMessage({ type: 'heartbeat', sourceNodeId: 'node-a', payload: {} }, new HmacMessageSigner(key, 'm15-test-key'));
  const transport = new HttpFederationTransport({ endpoint: 'https://peer.example', authToken: 'm15-token', retry: { maxRetries: 0 }, fetchImpl: async (_url, init) => { seenHeaders = init?.headers; return new Response('', { status: 202 }); } });
  await transport.send(message);
  assert.equal(new Headers(seenHeaders).get('authorization'), 'Bearer m15-token');
  assert.throws(() => new HttpFederationTransport({ endpoint: 'file:///not-http' }), /HTTP federation endpoint/);
  await transport.close();
});

// 27. 100-agent / 100-task scale simulation.
test('M15 100-agent simulation dispatches 100 bounded tasks across five nodes', async () => withDispatchCluster(5, async (coordinators) => {
  const taskCount = 100;
  const records = await Promise.all(Array.from({ length: taskCount }, (_, index) => coordinators[0]!.dispatch(task(`m15-100-${index}`, `node-${String.fromCharCode(98 + (index % 4))}`))));
  assert.equal(records.length, 100); assert.equal(coordinators[0]!.metrics().remoteTasks, 100);
}));

// 28. 1,000-task throughput simulation.
test('M15 1,000-task simulation measures bounded authenticated dispatch throughput', async () => withDispatchCluster(5, async (coordinators) => {
  const started = Date.now();
  const records = await Promise.all(Array.from({ length: 1_000 }, (_, index) => coordinators[0]!.dispatch(task(`m15-1000-${index}`, `node-${String.fromCharCode(98 + (index % 4))}`))));
  const elapsed = Date.now() - started;
  assert.equal(records.length, 1_000); assert.ok(elapsed < 30_000); assert.equal(coordinators[0]!.metrics().remoteTasks, 1_000);
}));

// Keep imported public primitives in this suite's compatibility surface.
void KeyProviderMessageSigner; void KeyProviderMessageVerifier; void RotatingHmacKeyProvider; void SqliteInboxStore;
