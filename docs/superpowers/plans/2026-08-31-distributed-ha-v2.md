# Distributed Runtime HA v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PostgreSQL-backed shared federation state, fenced leader election, and coordinator failover so multiple Helix coordinators can safely operate the same distributed runtime.

**Architecture:** Preserve the existing file-backed federation runtime for local mode. Add a focused HA store contract with a PostgreSQL implementation for concurrency-sensitive operations, then add a dedicated HA coordinator that requires a current leader term/fencing token for authoritative mutations.

**Tech Stack:** TypeScript 5.9, Node.js 22, PostgreSQL, `pg`, Node test runner, existing Helix federation HTTP transport.

**Spec:** `docs/superpowers/specs/2026-08-31-distributed-ha-v2-design.md`

## Global Constraints

- Preserve `DurableFederationState` and `DistributedRuntimeCoordinator` behavior.
- PostgreSQL HA mode is opt-in; never silently fall back to file state.
- Every authoritative HA mutation validates current leader term and fencing token.
- Task claim/result commit are transactional and single-writer at the row level.
- Standby coordinators never dispatch work.
- Stale leader and stale worker attempts fail closed.
- SQL is parameterized.
- CI must run a real PostgreSQL integration scenario.

---

### Task 1: HA store contracts and leader fencing

**Files:**
- Create: `packages/federation/src/ha-store.ts`
- Create: `tests/federation-ha-store.test.ts`
- Modify: `packages/federation/src/index.ts`

**Interfaces:**
- Produces: `FederationLeaderLease`, `LeadershipResult`, `HaTaskClaim`, `FederationHaStore`.
- Produces methods: `init`, `acquireLeadership`, `renewLeadership`, `assertLeadership`, `submitTask`, `getTask`, `listNodes`, `heartbeatNode`, `expireStaleNodes`, `claimTask`, `renewTaskLease`, `recoverExpiredTaskLeases`, `commitResult`, `findResultForTask`.

- [ ] **Step 1: Write failing contract tests**

Test an in-memory fake implementation target through a concrete `MemoryFederationHaStore` test helper: A gets term 1, B is standby, expiry lets B get term 2, and A's old token is rejected.

- [ ] **Step 2: Run CI and verify RED**

Expected: typecheck fails because HA store types/classes do not exist.

- [ ] **Step 3: Implement the minimal contract and memory reference store**

The memory store is a deterministic reference implementation used for coordinator unit tests; all mutations are serialized internally and use the same fencing rules required from PostgreSQL.

- [ ] **Step 4: Run full CI and verify GREEN**

Expected: install, typecheck, build, all tests pass.

---

### Task 2: PostgreSQL transactional HA store

**Files:**
- Create: `packages/federation/src/postgres-store.ts`
- Modify: `packages/federation/src/index.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/federation-postgres.test.ts`

**Interfaces:**
- Consumes: `FederationHaStore` from Task 1.
- Produces: `PostgresFederationStore` with constructor `{ connectionString, clusterId?, pool? }`.

- [ ] **Step 1: Write failing PostgreSQL integration tests**

When `HELIX_TEST_POSTGRES_URL` exists, create two `PostgresFederationStore` instances sharing one cluster id. Verify A term 1, B standby, B term 2 after expiry, stale A rejection, one transactional task claim, recovery, and exactly-once result commit.

- [ ] **Step 2: Add `pg` dependency and PostgreSQL CI service**

Use PostgreSQL 16 service with health checks and set `HELIX_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/helix_test` for the verify job.

- [ ] **Step 3: Implement schema initialization and parameterized transactional methods**

Use a `pg.Pool`; schema creation is idempotent. Leader operations and task claim/result commit use explicit `BEGIN` / `COMMIT` / `ROLLBACK` and `SELECT ... FOR UPDATE` where row ownership matters.

- [ ] **Step 4: Run full CI and verify GREEN**

Expected: the real PostgreSQL integration scenario and all legacy tests pass.

---

### Task 3: High-availability coordinator

**Files:**
- Create: `packages/federation/src/ha-runtime.ts`
- Modify: `packages/federation/src/index.ts`
- Create: `tests/distributed-ha-runtime.test.ts`

**Interfaces:**
- Consumes: `FederationHaStore`, existing `FederationTaskDispatcher`, `FederationRouter`.
- Produces: `HighAvailabilityDistributedCoordinator` with `campaign`, `renewLeadership`, `submit`, `runTask`, `runPending`, and `recover`.

- [ ] **Step 1: Write failing coordinator tests**

Use two coordinators with a shared memory HA store. Assert standby B cannot dispatch while A leads, A can run work, leadership expiry permits B takeover, B recovers expired worker lease, and A's stale commit is rejected.

- [ ] **Step 2: Run CI and verify RED**

Expected: failure because HA coordinator does not exist.

- [ ] **Step 3: Implement bounded leader/worker renewal and fenced dispatch**

Coordinator holds its current `FederationLeaderLease`; each operation validates it. During real-time remote dispatch renew both leadership and worker lease at bounded intervals. Deterministic `now` test mode skips timers and uses explicit timestamps.

- [ ] **Step 4: Run full CI and verify GREEN**

Expected: all coordinator and legacy tests pass.

---

### Task 4: Two-coordinator PostgreSQL failover verification

**Files:**
- Modify: `tests/federation-postgres.test.ts`
- Review: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `PostgresFederationStore`, `HighAvailabilityDistributedCoordinator`.

- [ ] **Step 1: Add end-to-end HA integration case**

Run two coordinators against one PostgreSQL database and deterministic dispatcher. A leads and creates work; B is rejected while standby; A expires; B obtains a higher term, recovers and completes the task; an A stale mutation fails; both stores read one terminal result.

- [ ] **Step 2: Run full CI and verify GREEN**

Required: install, typecheck, build, all tests including PostgreSQL integration pass.

- [ ] **Step 3: Compare feature branch to main**

Expected scope: HA spec/plan, federation HA store/runtime/Postgres implementation, tests, package dependency, lockfile and CI PostgreSQL service only.

- [ ] **Step 4: Open PR and require independent PR CI**

PR title: `feat: add PostgreSQL-backed distributed HA`

- [ ] **Step 5: Squash merge with expected head SHA and verify main CI**

Do not claim completion until the post-merge `main` verify job is green.