# Distributed Runtime / Multi-node Swarm Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable multi-node execution coordinator with fenced remote leases, health-aware scheduling, takeover after lease expiry, persistent remote results, and signed node heartbeats.

**Architecture:** Extend the existing federation state rather than creating a parallel scheduler. The coordinator owns authoritative task leases and result commitment; remote workers execute signed tasks over the existing HTTP plane. Lease id + attempt act as fencing tokens so stale workers cannot commit after takeover.

**Tech Stack:** TypeScript 5.9, Node.js 22, Node test runner, Helix DurableFederationState, FederationHttpClient/Server, HMAC federation envelopes.

**Spec:** `docs/superpowers/specs/2026-08-30-distributed-runtime-design.md`

## Global Constraints

- Preserve legacy non-leased federation HTTP behavior.
- Load existing federation state version 1 without data loss.
- Never accept a stale result after lease expiry/takeover.
- Transport failure does not release a lease early.
- Routing requires capabilities, online status, and fresh heartbeat.
- Quarantined nodes remain quarantined on heartbeat.
- Keep the origin state as the single authoritative writer in this tranche.

---

### Task 1: Durable leases and fencing

**Files:**
- Modify: `packages/federation/src/state.ts`
- Test: `tests/distributed-runtime.test.ts`

**Interfaces:**
- Produces: `FederationLease`, `acquireLease`, `heartbeatLease`, `recoverExpiredLeases`, `listLeases`, `commitLeasedResult`.
- Extends: `FederationTask.leaseId?`, `FederationResult.attempt`, `FederationResult.leaseId?`.

- [ ] **Step 1: Write the failing tests**

Create a durable state, enqueue one task, acquire attempt 1 on node A, verify a second acquisition is rejected, expire/recover the lease, acquire attempt 2 on node B, and assert a node-A result with attempt 1 is rejected while node-B attempt 2 commits and persists after restart.

- [ ] **Step 2: Run full CI and verify RED**

Expected: typecheck fails because the lease APIs/types do not exist.

- [ ] **Step 3: Implement minimal durable lease state**

Persist leases atomically, migrate version-1 state to version 2, increment task attempts only on lease acquisition, and perform strict result fencing before durable commit.

- [ ] **Step 4: Run full CI and verify GREEN**

Expected: install, typecheck, build, all tests pass.

---

### Task 2: Health-aware coordinator and takeover

**Files:**
- Create: `packages/federation/src/runtime.ts`
- Modify: `packages/federation/src/router.ts`
- Modify: `packages/federation/src/index.ts`
- Test: `tests/distributed-runtime.test.ts`

**Interfaces:**
- Produces: `DistributedRuntimeCoordinator` and durable node health methods `heartbeatNode`, `expireStaleNodes`.
- Consumes: Task 1 lease/fencing APIs and existing `FederationRouter` ordering.

- [ ] **Step 1: Write failing coordinator tests**

Register two capable nodes, make node A lower-load/fresher, route the first attempt to A, simulate an ambiguous dispatch failure, expire A heartbeat + lease, call recovery, and assert the same task is taken over by B as attempt 2 and completes once. Add a max-attempts assertion that refuses another lease after the configured bound.

- [ ] **Step 2: Run CI and verify RED**

Expected: failure because `DistributedRuntimeCoordinator`, node heartbeat persistence, and stale-node expiry do not exist.

- [ ] **Step 3: Implement coordinator**

Add submit/run/runPending/recover methods. Before routing, expire stale nodes. Acquire a durable lease, dispatch through the injected/current HTTP client, and rely on fenced result commit. On network error keep the lease active until recovery.

- [ ] **Step 4: Run full CI and verify GREEN**

Expected: coordinator tests and legacy suite pass.

---

### Task 3: Signed heartbeat transport and leased HTTP results

**Files:**
- Modify: `packages/federation/src/network.ts`
- Test: `tests/federation-http.test.ts`
- Test: `tests/distributed-runtime.test.ts`

**Interfaces:**
- Produces: `FederationHttpClient.sendHeartbeat(...)` and `/v1/federation/heartbeat` server route.
- Extends leased task response so `FederationResult` carries the dispatch attempt and lease id.

- [ ] **Step 1: Write failing network tests**

Start two local federation servers/states. Send a signed heartbeat from worker to coordinator and assert durable node health/load. Dispatch a leased task and assert the returned result carries the same fencing token and is committed by the origin state. Tampered heartbeat must be rejected.

- [ ] **Step 2: Run CI and verify RED**

Expected: failure because heartbeat transport and leased result metadata are missing.

- [ ] **Step 3: Implement network additions**

Generalize request routing for task/heartbeat POST endpoints, validate heartbeat envelope/source, return signed acknowledgement, and preserve legacy task dispatch behavior for tasks without a lease id.

- [ ] **Step 4: Run full CI and verify GREEN**

Expected: all tests pass with zero failures.

---

### Task 4: Integration review and delivery

**Files:**
- Review only; modify only if tests expose a concrete issue.

- [ ] **Step 1: Run final full CI on feature head**

Required: install, typecheck, build, test all green.

- [ ] **Step 2: Compare branch to main**

Confirm only federation runtime/state/router/network, tests, and design/plan docs changed.

- [ ] **Step 3: Open PR and wait for independent PR CI**

PR title: `feat: add distributed runtime failover`

- [ ] **Step 4: Squash merge with expected head SHA**

Only after PR is mergeable and PR CI is green.

- [ ] **Step 5: Verify post-merge main CI**

Do not claim completion until main install/typecheck/build/tests are green.
