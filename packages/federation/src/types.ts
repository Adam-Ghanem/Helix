import type { AgentId, TaskId } from '../../core/src/index.js';

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
  | 'task.completed' | 'task.failed' | 'task.cancel' | 'task.reassign'
  | 'heartbeat' | 'node.join' | 'node.leave'
  | 'lease.acquire' | 'lease.renew' | 'lease.release';

export interface FederationSecurityContext {
  subject: string;
  permissions: string[];
  trustLevel: FederationTrustLevel;
}

export interface FederationTaskPayload {
  taskId: TaskId | string;
  correlationId: string;
  traceId: string;
  priority: number;
  requiredCapabilities: string[];
  securityContext: FederationSecurityContext;
  authorizationContext: Record<string, string>;
  title?: string;
  input?: unknown;
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
  securityContext: FederationSecurityContext;
  authorizationContext: Record<string, string>;
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
}

export interface MessageVerifier {
  verify(message: FederationMessage): boolean;
}

export interface ReplayStore {
  has(messageId: string): boolean;
  remember(messageId: string, expiresAt: number): void;
  purge(now?: number): void;
}
