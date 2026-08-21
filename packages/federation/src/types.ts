import type { AgentId, TaskId, SandboxExecutionRequest } from '../../core/src/index.js';

export type FederationNodeRole = 'coordinator' | 'scheduler' | 'worker' | 'hybrid';
export type FederationNodeStatus = 'joining' | 'healthy' | 'degraded' | 'draining' | 'offline' | 'removed';
export type FederationTrustLevel = 'UNTRUSTED' | 'LIMITED' | 'TRUSTED' | 'ADMIN';
export type FederationSwarmTopology = 'hierarchical' | 'mesh' | 'adaptive';

export interface FederationNodeHealth {
  score: number;
  load: number;
  latencyMs: number;
  successRate: number;
  observedAt: string;
}

export interface FederationNode {
  id: string;
  name: string;
  endpoint: string;
  role: FederationNodeRole;
  capabilities: string[];
  status: FederationNodeStatus;
  health: FederationNodeHealth;
  lastHeartbeat: string;
  metadata: Record<string, string>;
  version: string;
  trustLevel: FederationTrustLevel;
}

export interface FederationNodeInput {
  id?: string;
  name: string;
  endpoint: string;
  role: FederationNodeRole;
  capabilities: string[];
  version?: string;
  metadata?: Record<string, string>;
  trustLevel?: FederationTrustLevel;
  status?: FederationNodeStatus;
}

export interface FederationNodeRegistryOptions {
  heartbeatTimeoutMs?: number;
  clock?: () => number;
}

export type FederationMessageType =
  | 'task.submit' | 'task.accept' | 'task.reject' | 'task.started' | 'task.progress'
  | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.cancel' | 'task.reassign'
  | 'heartbeat' | 'node.join' | 'node.leave'
  | 'lease.acquire' | 'lease.renew' | 'lease.release';

export interface FederationSecurityContext {
  subject: string;
  permissions: string[];
  trustLevel: FederationTrustLevel;
}

export interface FederationTaskPayload {
  taskId: TaskId | string;
  attemptId?: string;
  correlationId: string;
  traceId: string;
  priority: number;
  requiredCapabilities: string[];
  securityContext: FederationSecurityContext;
  authorizationContext: Record<string, string>;
  title?: string;
  input?: unknown;
  sandbox?: SandboxExecutionRequest;
}

export interface FederationMessage<T = unknown> {
  messageId: string;
  type: FederationMessageType;
  timestamp: string;
  sourceNodeId: string;
  destinationNodeId?: string;
  correlationId: string;
  traceId: string;
  payload: T;
  signature: string;
  schemaVersion: 1;
  expiresAt: string;
  nonce: string;
  keyId?: string;
  algorithm?: 'HMAC-SHA256' | 'ED25519' | 'MTLS';
  idempotencyKey?: string;
}

export interface FederationRoutingTask {
  taskId: string;
  requiredCapabilities: string[];
  priority?: number;
  locality?: 'local' | 'remote' | 'any';
  trustLevel?: FederationTrustLevel;
  nodeId?: string;
  correlationId?: string;
  traceId?: string;
  attemptId?: string;
  securityContext: FederationSecurityContext;
  authorizationContext: Record<string, string>;
  sandbox?: SandboxExecutionRequest;
}

export interface FederationRoutingDecision {
  taskId: string;
  nodeId: string;
  remote: boolean;
  score: number;
  rationale: string[];
}

export type DistributedLeaseStatus = 'active' | 'released' | 'expired' | 'fenced';

export interface DistributedLease {
  leaseId: string;
  taskId: string;
  ownerNodeId: string;
  expiresAt: number;
  renewedAt: number;
  fencingToken: number;
  status: DistributedLeaseStatus;
}

export interface LeaseStore {
  get(leaseId: string): DistributedLease | undefined;
  findByTask(taskId: string): DistributedLease | undefined;
  put(lease: DistributedLease): void;
  delete(leaseId: string): void;
  list(): DistributedLease[];
}

export interface DistributedLeaseOptions {
  defaultTtlMs?: number;
  clock?: () => number;
  store?: LeaseStore;
}

export interface FederationTaskRecord {
  taskId: string;
  attemptId: string;
  nodeId: string;
  local: boolean;
  status: 'queued' | 'accepted' | 'running' | 'completed' | 'failed' | 'reassigned' | 'cancelled';
  leaseId?: string;
  fencingToken?: number;
  correlationId: string;
  traceId: string;
  requiredCapabilities: string[];
  authorizationContext: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  error?: string;
  output?: unknown;
  timeout?: FederationTimeoutKind;
}

export interface FederationMetrics {
  nodesTotal: number;
  nodesHealthy: number;
  nodesDegraded: number;
  nodesOffline: number;
  localTasks: number;
  remoteTasks: number;
  remoteSuccessRate: number;
  remoteFailureRate: number;
  handoffs: number;
  leaseConflicts: number;
  leaseExpirations: number;
  messageFailures: number;
  replayRejections: number;
  signatureFailures: number;
  averageRemoteLatencyMs: number;
}

export interface FederationStatus {
  localNodeId: string;
  nodes: FederationNode[];
  tasks: FederationTaskRecord[];
  leases: DistributedLease[];
  metrics: FederationMetrics;
}

export interface FederationTransport {
  send<T>(message: FederationMessage<T>): Promise<void>;
  request<T, R>(message: FederationMessage<T>, timeoutMs?: number): Promise<FederationMessage<R>>;
  subscribe(handler: (message: FederationMessage) => void): () => void;
  close(): Promise<void>;
}

export interface FederatedSwarm {
  id: string;
  name: string;
  topology: FederationSwarmTopology;
  state: 'created' | 'running' | 'stopped' | 'failed';
  nodeIds: string[];
  taskIds: string[];
  maxNodes: number;
  trustLevel: FederationTrustLevel;
  createdAt: string;
  updatedAt: string;
}

export interface FederatedSwarmInput {
  id?: string;
  name: string;
  topology?: FederationSwarmTopology;
  maxNodes?: number;
  trustLevel?: FederationTrustLevel;
}

export interface FederatedTaskResult<T = unknown> {
  taskId: string;
  nodeId: string;
  success: boolean;
  value?: T;
  score?: number;
  error?: string;
  fencingToken: number;
}

export interface FederatedSwarmResult<T = unknown> {
  swarmId: string;
  success: boolean;
  score: number;
  results: FederatedTaskResult<T>[];
  completedTasks: string[];
  failedTasks: string[];
}

export interface MessageSigner {
  sign(message: Omit<FederationMessage, 'signature'>): string;
  readonly keyId?: string;
  readonly algorithm?: FederationMessage['algorithm'];
}

export interface MessageVerifier {
  verify(message: FederationMessage): boolean;
}

export interface KeyProvider {
  active(): { keyId: string; secret: string; algorithm: 'HMAC-SHA256' };
  get(keyId: string): { keyId: string; secret: string; algorithm: 'HMAC-SHA256' } | undefined;
  previous(): Array<{ keyId: string; secret: string; algorithm: 'HMAC-SHA256' }>;
}

export interface PeerIdentity {
  nodeId: string;
  keyId: string;
  algorithm: 'HMAC-SHA256' | 'ED25519' | 'MTLS';
  trustLevel: FederationTrustLevel;
  endpoint?: string;
}

export interface PeerAuthenticator {
  authenticate(message: FederationMessage, peer: PeerIdentity): boolean;
}

export interface FederationRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs?: number;
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'dead-letter';
export interface FederationOutboxRecord {
  id: string;
  messageId: string;
  destination: string;
  payload: FederationMessage;
  attempts: number;
  nextAttemptAt: number;
  createdAt: string;
  status: OutboxStatus;
  lastError?: string;
  idempotencyKey: string;
}

export type FederationOutboxInput = Pick<FederationOutboxRecord, 'messageId' | 'destination' | 'payload' | 'idempotencyKey'> & Partial<Pick<FederationOutboxRecord, 'id'>>;
export interface OutboxStore {
  enqueue(record: FederationOutboxInput): FederationOutboxRecord;
  claim(limit?: number, now?: number): FederationOutboxRecord[];
  ack(id: string): FederationOutboxRecord;
  retry(id: string, error: string, nextAttemptAt: number): FederationOutboxRecord;
  deadLetter(id: string, error: string): FederationOutboxRecord;
  listPending(): FederationOutboxRecord[];
  listDeadLetters(): FederationOutboxRecord[];
  count(status?: OutboxStatus): number;
}

export type InboxMessageStatus = 'received' | 'processed' | 'failed';
export interface InboxRecord {
  messageId: string;
  idempotencyKey: string;
  receivedAt: string;
  status: InboxMessageStatus;
  attempts: number;
  lastError?: string;
}

export interface InboxStore {
  seen(messageId: string, idempotencyKey?: string): boolean;
  markProcessed(messageId: string): InboxRecord;
  markFailed(messageId: string, error: string): InboxRecord;
  cleanup(before: number): number;
  list(): InboxRecord[];
}

export type FederationNodeRuntimeState = 'created' | 'starting' | 'ready' | 'draining' | 'stopped' | 'failed';
export type FederationTimeoutKind = 'EXECUTION_TIMEOUT' | 'NETWORK_TIMEOUT' | 'LEASE_TIMEOUT';
export interface FederationExecutionOutcome {
  taskId: string;
  attemptId: string;
  nodeId: string;
  status: 'completed' | 'failed' | 'cancelled';
  output?: unknown;
  error?: string;
  timeout?: FederationTimeoutKind;
  startedAt: string;
  completedAt: string;
  provenance: { sourceNodeId?: string; agentId?: string; taskId: string; attemptId: string; timestamp: string };
}

export interface FederationNodeRuntimeStatus {
  nodeId: string;
  state: FederationNodeRuntimeState;
  activeTasks: number;
  acceptingTasks: boolean;
  lastHeartbeat: string;
  outboxPending: number;
  deadLetters: number;
}

export interface FederationRuntimeOptions {
  heartbeatIntervalMs?: number;
  drainDeadlineMs?: number;
  executionTimeoutMs?: number;
}

export interface FaultInjectionRule {
  action: 'drop' | 'delay' | 'duplicate' | 'corrupt' | 'partition' | 'crash';
  messageType?: FederationMessageType;
  messageId?: string;
  delayMs?: number;
  remaining?: number;
}


export interface ReplayStore {
  has(messageId: string): boolean;
  remember(messageId: string, expiresAt: number): void;
  purge(now?: number): void;
}
