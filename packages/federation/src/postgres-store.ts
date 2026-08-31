import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { FederationNode } from './index.js';
import type { FederationNodeHeartbeat, FederationResult, FederationTask } from './state.js';
import type {
  FederationHaStore,
  FederationHaTask,
  FederationLeaderLease,
  HaTaskClaim,
  HaTaskLeaseOptions,
  LeadershipOptions,
  LeadershipResult,
} from './ha-store.js';

export interface PostgresFederationStoreOptions {
  connectionString?: string;
  clusterId?: string;
  pool?: Pool;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

interface LeaderRow {
  cluster_id: string;
  leader_id: string;
  term: string | number;
  fencing_token: string;
  heartbeat_at: Date;
  expires_at: Date;
}

interface NodeRow {
  id: string;
  endpoint: string;
  capabilities: unknown;
  status: FederationNode['status'];
  last_heartbeat: Date | null;
  load: number | string | null;
}

interface TaskRow {
  id: string;
  execution_id: string;
  task_type: string;
  goal: string;
  required_capabilities: unknown;
  payload: unknown;
  assigned_node_id: string | null;
  lease_id: string | null;
  lease_expires_at: Date | null;
  status: FederationTask['status'];
  attempt: number;
  created_at: Date;
  updated_at: Date;
  error: string | null;
  leader_term: string | number | null;
  leader_fencing_token: string | null;
}

interface ResultRow {
  id: string;
  task_id: string;
  execution_id: string;
  node_id: string;
  lease_id: string | null;
  attempt: number;
  success: boolean;
  output: unknown;
  error: string | null;
  created_at: Date;
}

export class PostgresFederationStore implements FederationHaStore {
  private readonly clusterId: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private initialized = false;

  constructor(options: PostgresFederationStoreOptions) {
    this.clusterId = options.clusterId?.trim() || 'default';
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      if (!options.connectionString?.trim()) throw new Error('PostgreSQL federation connectionString is required when pool is not supplied');
      this.pool = new Pool({ connectionString: options.connectionString });
      this.ownsPool = true;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // CREATE TABLE IF NOT EXISTS is not sufficient when two fresh processes bootstrap
      // the same schema concurrently: PostgreSQL catalog type creation can still race.
      // A transaction-scoped advisory lock serializes schema bootstrap across hosts.
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [121250107, 1]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS helix_federation_leader (
          cluster_id text PRIMARY KEY,
          leader_id text NOT NULL,
          term bigint NOT NULL CHECK (term >= 1),
          fencing_token text NOT NULL,
          heartbeat_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL
        );

        CREATE TABLE IF NOT EXISTS helix_federation_nodes (
          cluster_id text NOT NULL,
          id text NOT NULL,
          endpoint text NOT NULL,
          capabilities jsonb NOT NULL,
          status text NOT NULL CHECK (status IN ('online', 'offline', 'quarantined')),
          last_heartbeat timestamptz,
          load double precision NOT NULL DEFAULT 0 CHECK (load >= 0),
          PRIMARY KEY (cluster_id, id)
        );

        CREATE TABLE IF NOT EXISTS helix_federation_tasks (
          cluster_id text NOT NULL,
          id text NOT NULL,
          execution_id text NOT NULL,
          task_type text NOT NULL,
          goal text NOT NULL,
          required_capabilities jsonb NOT NULL,
          payload jsonb NOT NULL,
          assigned_node_id text,
          lease_id text,
          lease_expires_at timestamptz,
          status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
          attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          error text,
          leader_term bigint,
          leader_fencing_token text,
          PRIMARY KEY (cluster_id, id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS helix_federation_tasks_active_lease
          ON helix_federation_tasks(cluster_id, lease_id)
          WHERE lease_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS helix_federation_results (
          cluster_id text NOT NULL,
          id text NOT NULL,
          task_id text NOT NULL,
          execution_id text NOT NULL,
          node_id text NOT NULL,
          lease_id text,
          attempt integer NOT NULL CHECK (attempt >= 0),
          success boolean NOT NULL,
          output jsonb,
          error text,
          created_at timestamptz NOT NULL,
          PRIMARY KEY (cluster_id, id),
          UNIQUE (cluster_id, task_id, attempt)
        );
      `);
      await client.query('COMMIT');
      this.initialized = true;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the schema bootstrap error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async acquireLeadership(coordinatorId: string, options: LeadershipOptions): Promise<LeadershipResult> {
    this.assertInitialized();
    validateLeaseDuration(options.ttlMs, 'leader ttl');
    if (!coordinatorId.trim()) throw new Error('Coordinator id is required');
    const now = options.now ?? Date.now();
    const expiresAt = new Date(now + options.ttlMs);
    const heartbeatAt = new Date(now);

    return this.transaction(async (client) => {
      const insertedToken = randomUUID();
      const inserted = await client.query<LeaderRow>(
        `INSERT INTO helix_federation_leader(cluster_id, leader_id, term, fencing_token, heartbeat_at, expires_at)
         VALUES ($1, $2, 1, $3, $4, $5)
         ON CONFLICT (cluster_id) DO NOTHING
         RETURNING *`,
        [this.clusterId, coordinatorId, insertedToken, heartbeatAt, expiresAt],
      );
      if (inserted.rowCount === 1) return { acquired: true, lease: leaderFromRow(inserted.rows[0]!) };

      const currentQuery = await client.query<LeaderRow>(
        'SELECT * FROM helix_federation_leader WHERE cluster_id = $1 FOR UPDATE',
        [this.clusterId],
      );
      const current = currentQuery.rows[0];
      if (!current) throw new Error('PostgreSQL federation leader row disappeared during campaign');
      const currentLease = leaderFromRow(current);

      if (currentLease.leaderId === coordinatorId && currentLease.expiresAt > now) {
        const renewed = await client.query<LeaderRow>(
          `UPDATE helix_federation_leader
           SET heartbeat_at = $2, expires_at = $3
           WHERE cluster_id = $1
           RETURNING *`,
          [this.clusterId, heartbeatAt, expiresAt],
        );
        return { acquired: true, lease: leaderFromRow(renewed.rows[0]!) };
      }

      if (currentLease.expiresAt > now) return { acquired: false, lease: currentLease };

      const token = randomUUID();
      const takeover = await client.query<LeaderRow>(
        `UPDATE helix_federation_leader
         SET leader_id = $2, term = term + 1, fencing_token = $3, heartbeat_at = $4, expires_at = $5
         WHERE cluster_id = $1
         RETURNING *`,
        [this.clusterId, coordinatorId, token, heartbeatAt, expiresAt],
      );
      return { acquired: true, lease: leaderFromRow(takeover.rows[0]!) };
    });
  }

  async renewLeadership(lease: FederationLeaderLease, options: LeadershipOptions): Promise<FederationLeaderLease> {
    this.assertInitialized();
    validateLeaseDuration(options.ttlMs, 'leader ttl');
    const now = options.now ?? Date.now();
    return this.transaction(async (client) => {
      await this.lockAndAssertLeadership(client, lease, now);
      const updated = await client.query<LeaderRow>(
        `UPDATE helix_federation_leader
         SET heartbeat_at = $2, expires_at = $3
         WHERE cluster_id = $1
         RETURNING *`,
        [this.clusterId, new Date(now), new Date(now + options.ttlMs)],
      );
      return leaderFromRow(updated.rows[0]!);
    });
  }

  async assertLeadership(lease: FederationLeaderLease, now = Date.now()): Promise<void> {
    this.assertInitialized();
    const result = await this.pool.query<LeaderRow>(
      'SELECT * FROM helix_federation_leader WHERE cluster_id = $1',
      [this.clusterId],
    );
    const current = result.rows[0];
    if (!current || !sameLeader(leaderFromRow(current), lease) || current.expires_at.getTime() <= now) throw new Error('Stale leader lease');
  }

  async submitTask(
    lease: FederationLeaderLease,
    input: Omit<FederationTask, 'id' | 'assignedNodeId' | 'leaseId' | 'status' | 'attempt' | 'createdAt' | 'updatedAt' | 'error'>,
    now = Date.now(),
  ): Promise<FederationHaTask> {
    this.assertInitialized();
    validateTaskInput(input);
    return this.transaction(async (client) => {
      await this.lockAndAssertLeadership(client, lease, now);
      const id = `fedt_${randomUUID()}`;
      const at = new Date(now);
      const result = await client.query<TaskRow>(
        `INSERT INTO helix_federation_tasks(
           cluster_id, id, execution_id, task_type, goal, required_capabilities, payload,
           status, attempt, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'queued',0,$8,$8)
         RETURNING *`,
        [
          this.clusterId,
          id,
          input.executionId,
          input.taskType,
          input.goal,
          JSON.stringify([...new Set(input.requiredCapabilities)]),
          JSON.stringify(input.payload),
          at,
        ],
      );
      return taskFromRow(result.rows[0]!);
    });
  }

  async getTask(taskId: string): Promise<FederationHaTask | undefined> {
    this.assertInitialized();
    const result = await this.pool.query<TaskRow>(
      'SELECT * FROM helix_federation_tasks WHERE cluster_id = $1 AND id = $2',
      [this.clusterId, taskId],
    );
    return result.rows[0] ? taskFromRow(result.rows[0]) : undefined;
  }

  async listTasks(): Promise<FederationHaTask[]> {
    this.assertInitialized();
    const result = await this.pool.query<TaskRow>(
      'SELECT * FROM helix_federation_tasks WHERE cluster_id = $1 ORDER BY created_at, id',
      [this.clusterId],
    );
    return result.rows.map(taskFromRow);
  }

  async listNodes(): Promise<FederationNode[]> {
    this.assertInitialized();
    const result = await this.pool.query<NodeRow>(
      'SELECT id, endpoint, capabilities, status, last_heartbeat, load FROM helix_federation_nodes WHERE cluster_id = $1 ORDER BY id',
      [this.clusterId],
    );
    return result.rows.map(nodeFromRow);
  }

  async heartbeatNode(input: FederationNodeHeartbeat, now = Date.now()): Promise<FederationNode> {
    this.assertInitialized();
    validateHeartbeat(input);
    const result = await this.pool.query<NodeRow>(
      `INSERT INTO helix_federation_nodes(cluster_id,id,endpoint,capabilities,status,last_heartbeat,load)
       VALUES ($1,$2,$3,$4::jsonb,'online',$5,$6)
       ON CONFLICT (cluster_id,id) DO UPDATE SET
         endpoint = EXCLUDED.endpoint,
         capabilities = EXCLUDED.capabilities,
         status = CASE WHEN helix_federation_nodes.status = 'quarantined' THEN 'quarantined' ELSE 'online' END,
         last_heartbeat = EXCLUDED.last_heartbeat,
         load = EXCLUDED.load
       RETURNING id, endpoint, capabilities, status, last_heartbeat, load`,
      [this.clusterId, input.id, input.endpoint, JSON.stringify([...new Set(input.capabilities)]), new Date(now), normalizeLoad(input.load)],
    );
    return nodeFromRow(result.rows[0]!);
  }

  async expireStaleNodes(lease: FederationLeaderLease, timeoutMs: number, now = Date.now()): Promise<FederationNode[]> {
    this.assertInitialized();
    validateLeaseDuration(timeoutMs, 'heartbeat timeout');
    return this.transaction(async (client) => {
      await this.lockAndAssertLeadership(client, lease, now);
      const result = await client.query<NodeRow>(
        `UPDATE helix_federation_nodes
         SET status = 'offline'
         WHERE cluster_id = $1 AND status = 'online' AND (last_heartbeat IS NULL OR last_heartbeat < $2)
         RETURNING id, endpoint, capabilities, status, last_heartbeat, load`,
        [this.clusterId, new Date(now - timeoutMs)],
      );
      return result.rows.map(nodeFromRow);
    });
  }

  async claimTask(lease: FederationLeaderLease, taskId: string, nodeId: string, options: HaTaskLeaseOptions): Promise<HaTaskClaim> {
    this.assertInitialized();
    validateLeaseDuration(options.leaseMs, 'task lease');
    const now = options.now ?? Date.now();
    return this.transaction(async (client) => {
      await this.lockAndAssertLeadership(client, lease, now);
      const taskResult = await client.query<TaskRow>(
        'SELECT * FROM helix_federation_tasks WHERE cluster_id = $1 AND id = $2 FOR UPDATE',
        [this.clusterId, taskId],
      );
      const row = taskResult.rows[0];
      if (!row) throw new Error(`Unknown federation task: ${taskId}`);
      const task = taskFromRow(row);
      if (task.status !== 'queued') throw new Error(`Federation task ${taskId} cannot be claimed while ${task.status}`);

      const nodeResult = await client.query<NodeRow>(
        'SELECT id, endpoint, capabilities, status, last_heartbeat, load FROM helix_federation_nodes WHERE cluster_id = $1 AND id = $2',
        [this.clusterId, nodeId],
      );
      const nodeRow = nodeResult.rows[0];
      if (!nodeRow) throw new Error(`Federation node ${nodeId} is not registered`);
      const node = nodeFromRow(nodeRow);
      if (node.status !== 'online') throw new Error(`Federation node ${nodeId} is not online`);
      if (!task.requiredCapabilities.every((capability) => node.capabilities.includes(capability))) throw new Error(`Federation node ${nodeId} lacks required capabilities`);

      const leaseId = `fedl_${randomUUID()}`;
      const updated = await client.query<TaskRow>(
        `UPDATE helix_federation_tasks SET
           status='running', attempt=attempt+1, assigned_node_id=$3, lease_id=$4,
           lease_expires_at=$5, leader_term=$6, leader_fencing_token=$7, error=NULL, updated_at=$8
         WHERE cluster_id=$1 AND id=$2
         RETURNING *`,
        [this.clusterId, taskId, nodeId, leaseId, new Date(now + options.leaseMs), lease.term, lease.fencingToken, new Date(now)],
      );
      const claimed = taskFromRow(updated.rows[0]!);
      return { task: claimed, leaseId, leaderTerm: lease.term, leaderFencingToken: lease.fencingToken };
    });
  }

  async renewTaskLease(lease: FederationLeaderLease, leaseId: string, nodeId: string, options: HaTaskLeaseOptions): Promise<HaTaskClaim> {
    this.assertInitialized();
    validateLeaseDuration(options.leaseMs, 'task lease');
    const now = options.now ?? Date.now();
    return this.transaction(async (client) => {
      await this.lockAndAssertLeadership(client, lease, now);
      const result = await client.query<TaskRow>(
        'SELECT * FROM helix_federation_tasks WHERE cluster_id=$1 AND lease_id=$2 FOR UPDATE',
        [this.clusterId, leaseId],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Unknown active federation task lease: ${leaseId}`);
      const task = taskFromRow(row);
      if (task.status !== 'running' || task.assignedNodeId !== nodeId) throw new Error(`Federation task lease ${leaseId} belongs to another node or is inactive`);
      if ((task.leaseExpiresAt ?? 0) <= now) throw new Error(`Federation task lease ${leaseId} has expired`);
      if (task.leaderTerm !== lease.term || task.leaderFencingToken !== lease.fencingToken) throw new Error('Stale leader task lease');

      const updated = await client.query<TaskRow>(
        `UPDATE helix_federation_tasks SET lease_expires_at=$3, updated_at=$4
         WHERE cluster_id=$1 AND id=$2 RETURNING *`,
        [this.clusterId, task.id, new Date(now + options.leaseMs), new Date(now)],
      );
      return { task: taskFromRow(updated.rows[0]!), leaseId, leaderTerm: lease.term, leaderFencingToken: lease.fencingToken };
    });
  }

  async recoverExpiredTaskLeases(lease: FederationLeaderLease, now = Date.now()): Promise<FederationHaTask[]> {
    this.assertInitialized();
    return this.transaction(async (client) => {
      await this.lockAndAssertLeadership(client, lease, now);
      const locked = await client.query<TaskRow>(
        `SELECT * FROM helix_federation_tasks
         WHERE cluster_id=$1 AND status='running' AND lease_expires_at <= $2
         FOR UPDATE`,
        [this.clusterId, new Date(now)],
      );
      if (locked.rowCount === 0) return [];
      const ids = locked.rows.map((row) => row.id);
      const recovered = await client.query<TaskRow>(
        `UPDATE helix_federation_tasks SET
           status='queued', assigned_node_id=NULL, lease_id=NULL, lease_expires_at=NULL,
           leader_term=NULL, leader_fencing_token=NULL, updated_at=$3
         WHERE cluster_id=$1 AND id = ANY($2::text[])
         RETURNING *`,
        [this.clusterId, ids, new Date(now)],
      );
      return recovered.rows.map(taskFromRow);
    });
  }

  async commitResult(lease: FederationLeaderLease, result: FederationResult, now = Date.now()): Promise<FederationResult> {
    this.assertInitialized();
    validateResult(result);
    return this.transaction(async (client) => {
      await this.lockAndAssertLeadership(client, lease, now);

      const existingById = await client.query<ResultRow>(
        'SELECT * FROM helix_federation_results WHERE cluster_id=$1 AND id=$2',
        [this.clusterId, result.id],
      );
      if (existingById.rows[0]) return resultFromRow(existingById.rows[0]);

      const existingAttempt = await client.query<ResultRow>(
        'SELECT * FROM helix_federation_results WHERE cluster_id=$1 AND task_id=$2 AND attempt=$3',
        [this.clusterId, result.taskId, result.attempt],
      );
      if (existingAttempt.rows[0]) return resultFromRow(existingAttempt.rows[0]);

      const taskResult = await client.query<TaskRow>(
        'SELECT * FROM helix_federation_tasks WHERE cluster_id=$1 AND id=$2 FOR UPDATE',
        [this.clusterId, result.taskId],
      );
      const row = taskResult.rows[0];
      if (!row) throw new Error(`Unknown federation task: ${result.taskId}`);
      const task = taskFromRow(row);
      if (task.status !== 'running' || !result.leaseId || task.leaseId !== result.leaseId || task.assignedNodeId !== result.nodeId || task.attempt !== result.attempt) {
        throw new Error('Stale federation result: worker lease fencing mismatch');
      }
      if ((task.leaseExpiresAt ?? 0) <= now) throw new Error('Stale federation result: worker lease expired');
      if (task.executionId !== result.executionId) throw new Error('Federation result execution does not match task');
      if (task.leaderTerm !== lease.term || task.leaderFencingToken !== lease.fencingToken) throw new Error('Stale leader result commit');

      const inserted = await client.query<ResultRow>(
        `INSERT INTO helix_federation_results(
           cluster_id,id,task_id,execution_id,node_id,lease_id,attempt,success,output,error,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
         RETURNING *`,
        [
          this.clusterId,
          result.id,
          result.taskId,
          result.executionId,
          result.nodeId,
          result.leaseId,
          result.attempt,
          result.success,
          result.output === undefined ? null : JSON.stringify(result.output),
          result.error ?? null,
          new Date(result.createdAt),
        ],
      );

      await client.query(
        `UPDATE helix_federation_tasks SET
           status=$3, lease_id=NULL, lease_expires_at=NULL, leader_term=NULL, leader_fencing_token=NULL,
           error=$4, updated_at=$5
         WHERE cluster_id=$1 AND id=$2`,
        [this.clusterId, task.id, result.success ? 'completed' : 'failed', result.success ? null : (result.error ?? 'Federation task failed'), new Date(now)],
      );
      return resultFromRow(inserted.rows[0]!);
    });
  }

  async findResultForTask(taskId: string, attempt?: number): Promise<FederationResult | undefined> {
    this.assertInitialized();
    const values: unknown[] = [this.clusterId, taskId];
    let where = 'cluster_id=$1 AND task_id=$2';
    if (attempt !== undefined) {
      values.push(attempt);
      where += ' AND attempt=$3';
    }
    const result = await this.pool.query<ResultRow>(
      `SELECT * FROM helix_federation_results WHERE ${where} ORDER BY attempt DESC, created_at DESC LIMIT 1`,
      values,
    );
    return result.rows[0] ? resultFromRow(result.rows[0]) : undefined;
  }

  private async lockAndAssertLeadership(client: PoolClient, lease: FederationLeaderLease, now: number): Promise<FederationLeaderLease> {
    const result = await client.query<LeaderRow>(
      'SELECT * FROM helix_federation_leader WHERE cluster_id=$1 FOR UPDATE',
      [this.clusterId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Stale leader lease');
    const current = leaderFromRow(row);
    if (!sameLeader(current, lease) || current.expiresAt <= now) throw new Error('Stale leader lease');
    return current;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('PostgresFederationStore.init() must be called first');
  }
}

function leaderFromRow(row: LeaderRow): FederationLeaderLease {
  return {
    clusterId: row.cluster_id,
    leaderId: row.leader_id,
    term: Number(row.term),
    fencingToken: row.fencing_token,
    heartbeatAt: row.heartbeat_at.toISOString(),
    expiresAt: row.expires_at.getTime(),
  };
}

function sameLeader(left: FederationLeaderLease, right: FederationLeaderLease): boolean {
  return left.clusterId === right.clusterId
    && left.leaderId === right.leaderId
    && left.term === right.term
    && left.fencingToken === right.fencingToken;
}

function nodeFromRow(row: NodeRow): FederationNode {
  const capabilities = stringArray(row.capabilities, 'node capabilities');
  return {
    id: row.id,
    endpoint: row.endpoint,
    capabilities,
    status: row.status,
    ...(row.last_heartbeat ? { lastHeartbeat: row.last_heartbeat.toISOString() } : {}),
    load: row.load === null ? 0 : Number(row.load),
  };
}

function taskFromRow(row: TaskRow): FederationHaTask {
  const task: FederationHaTask = {
    id: row.id,
    executionId: row.execution_id,
    taskType: row.task_type,
    goal: row.goal,
    requiredCapabilities: stringArray(row.required_capabilities, 'task capabilities'),
    payload: recordValue(row.payload, 'task payload'),
    status: row.status,
    attempt: Number(row.attempt),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (row.assigned_node_id !== null) task.assignedNodeId = row.assigned_node_id;
  if (row.lease_id !== null) task.leaseId = row.lease_id;
  if (row.lease_expires_at !== null) task.leaseExpiresAt = row.lease_expires_at.getTime();
  if (row.error !== null) task.error = row.error;
  if (row.leader_term !== null) task.leaderTerm = Number(row.leader_term);
  if (row.leader_fencing_token !== null) task.leaderFencingToken = row.leader_fencing_token;
  return task;
}

function resultFromRow(row: ResultRow): FederationResult {
  const result: FederationResult = {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    attempt: Number(row.attempt),
    success: row.success,
    createdAt: row.created_at.toISOString(),
  };
  if (row.lease_id !== null) result.leaseId = row.lease_id;
  if (row.output !== null) result.output = structuredClone(row.output);
  if (row.error !== null) result.error = row.error;
  return result;
}

function validateLeaseDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
}

function validateTaskInput(input: Omit<FederationTask, 'id' | 'assignedNodeId' | 'leaseId' | 'status' | 'attempt' | 'createdAt' | 'updatedAt' | 'error'>): void {
  if (!input.executionId.trim() || !input.taskType.trim() || !input.goal.trim()) throw new Error('Distributed task identifiers and goal are required');
  if (!Array.isArray(input.requiredCapabilities) || input.requiredCapabilities.some((capability) => typeof capability !== 'string' || !capability.trim())) {
    throw new Error('Distributed task capabilities must be non-empty strings');
  }
  recordValue(input.payload, 'task payload');
}

function validateHeartbeat(input: FederationNodeHeartbeat): void {
  if (!input.id.trim() || !/^https?:\/\//.test(input.endpoint)) throw new Error('Invalid federation heartbeat node');
  if (!Array.isArray(input.capabilities) || input.capabilities.some((capability) => typeof capability !== 'string' || !capability.trim())) throw new Error('Invalid federation capabilities');
  normalizeLoad(input.load);
}

function validateResult(result: FederationResult): void {
  if (!result.id.trim() || !result.taskId.trim() || !result.executionId.trim() || !result.nodeId.trim()) throw new Error('Federation result identifiers are required');
  if (!Number.isInteger(result.attempt) || result.attempt < 1) throw new Error('Federation result attempt must be a positive integer');
  if (!Number.isFinite(Date.parse(result.createdAt))) throw new Error('Federation result createdAt is invalid');
}

function normalizeLoad(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) throw new Error('Federation node load must be a non-negative number');
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`Invalid ${label} in PostgreSQL federation state`);
  return value as string[];
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} in PostgreSQL federation state`);
  return structuredClone(value) as Record<string, unknown>;
}
