# Distributed Runtime HA v2 Design

## Goal

Remove the single-coordinator/single-writer limitation from Helix distributed execution by introducing a shared transactional federation store and fenced leader election, while preserving the existing file-backed local mode.

## Current limitation

The current `DurableFederationState` persists JSON atomically, but each process owns its own in-memory Maps. Atomic rename protects one file write; it does not provide multi-process or multi-host transactions. Two coordinators can therefore act on stale snapshots and both believe they are authoritative.

## Architecture

### Store abstraction

Introduce a narrow `FederationStore` contract used by the distributed coordinator for authoritative HA operations. Existing file-backed state remains supported for local and legacy operation. A PostgreSQL-backed implementation provides the shared transactional backend for HA mode.

The first HA tranche intentionally does not rewrite every federation helper around the abstraction. It moves the concurrency-sensitive operations first: leader election, leader renewal, leader fencing checks, task claiming, lease renewal, result commit, task/result lookup, and recovery of expired leases. Existing message-signing and HTTP transport remain unchanged.

### PostgreSQL schema

Use dedicated tables:

- `helix_federation_leader`: singleton row for the active coordinator leader lease.
- `helix_federation_nodes`: node health, endpoint, capabilities, load, heartbeat timestamp and status.
- `helix_federation_tasks`: durable distributed tasks and current worker lease metadata.
- `helix_federation_results`: immutable task attempt results.

Leader row fields:

- `cluster_id text primary key`
- `leader_id text not null`
- `term bigint not null`
- `fencing_token uuid not null`
- `heartbeat_at timestamptz not null`
- `expires_at timestamptz not null`

Task rows carry `leader_term` and `leader_fencing_token` for every authoritative mutation. Result commit validates the current leader record and task lease in one SQL transaction.

### Leader election

`PostgresFederationStore.acquireLeadership(coordinatorId, ttlMs)` performs a transaction with `SELECT ... FOR UPDATE` on the cluster leader row.

- If no row exists, create term 1.
- If the same coordinator still owns an unexpired term, renew it without incrementing term.
- If the lease expired, a contender takes over with `term + 1` and a new fencing token.
- If another live leader owns the lease, return a non-leader result rather than stealing leadership.

Every authoritative coordinator action supplies the leader term and fencing token. A stale coordinator is rejected even if it still has process-local state.

### Worker leases

Task claiming uses one database transaction and row-level locking:

1. validate current leader token;
2. lock the queued task row;
3. choose/validate a healthy worker node;
4. increment attempt;
5. create worker `lease_id`, `lease_expires_at`, assigned node and leader fencing metadata;
6. commit.

A second coordinator cannot claim the same row concurrently.

Worker lease renewal and result commit also validate the leader token and current task attempt/lease before updating.

### Coordinator behavior

Add `HighAvailabilityDistributedCoordinator` rather than silently changing the existing local coordinator semantics.

Responsibilities:

- acquire or renew leadership;
- reject dispatch/recovery when not leader;
- submit durable tasks to the shared store;
- route against shared node health;
- atomically claim a task;
- renew leader and worker leases during long remote dispatch;
- commit fenced results;
- recover expired worker leases after takeover;
- allow a standby coordinator to become leader after leader TTL expiry and continue queued/recovered work.

### Failure semantics

- A non-leader never dispatches work.
- Losing leadership while a remote dispatch is in flight makes later commit fail closed.
- Old leader term/fencing token is never accepted after takeover.
- Ambiguous remote transport failure keeps the worker lease until expiry.
- Standby recovery only requeues expired worker leases.
- Stale worker results remain rejected by `lease_id + attempt` fencing.
- PostgreSQL errors fail the HA operation; there is no silent fallback to the file store.

### Compatibility

- Existing `DurableFederationState`, federation HTTP client/server, and `DistributedRuntimeCoordinator` stay available.
- No production caller is forced to run PostgreSQL.
- HA mode is opt-in by constructing `PostgresFederationStore` and `HighAvailabilityDistributedCoordinator`.

## Security

- PostgreSQL connection strings are supplied through caller configuration/environment and never persisted in federation task state.
- SQL uses parameterized queries only.
- Leader fencing is mandatory on every authoritative mutation.
- No remote shell execution is introduced.
- Existing HMAC signed federation transport remains the network trust layer in this tranche.

## Testing

### Unit/contract tests

Use a minimal SQL-client abstraction with a fake transactional client to verify:

- leader acquisition, renewal and takeover term increment;
- stale fencing token rejection;
- transactional task claim semantics;
- result commit validation;
- coordinator refuses work when standby.

### PostgreSQL integration test

GitHub Actions starts a PostgreSQL service. A dedicated integration test uses two store/coordinator instances against the same database:

1. coordinator A becomes leader and submits a task;
2. coordinator B cannot claim while A's leader lease is live;
3. A's leader lease is allowed to expire;
4. B acquires a higher term and recovers/claims work;
5. a stale mutation from A is rejected;
6. B commits the task result exactly once;
7. both coordinator instances observe the same terminal durable state.

The integration test runs only when `HELIX_TEST_POSTGRES_URL` is present, and CI sets that variable explicitly. Local test runs without PostgreSQL keep the rest of the suite runnable.

## Non-goals

This tranche does not add Redis, etcd, Kubernetes leader election, multi-region consensus, or schema migration tooling. PostgreSQL is the single shared HA coordination primitive for now. It also does not replace the existing federation HMAC transport or sandbox subsystem.