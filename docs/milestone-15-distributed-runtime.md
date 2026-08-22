# M15 Production Distributed Execution

## Scope

M15 turns the M14 federation adapter into a bounded distributed execution runtime. A Helix node can now accept an authenticated remote task, execute it through the existing `HelixRuntime` scheduler, worker, sandbox, policy, memory, and learning path, and return signed completion, failure, cancellation, or timeout evidence to the source node.

M15 is an execution adapter, not a replacement orchestration stack. It does not introduce a second scheduler, worker pool, memory backend, agent registry, policy engine, sandbox manager, MCP authorization layer, distributed database, quorum protocol, or Byzantine fault-tolerance mechanism.

## Control plane and execution plane

The **control plane** remains responsible for node identity and health, capability-safe routing, trust-boundary checks, signed message envelopes, correlation and trace identifiers, leases, fencing tokens, durable outbox/inbox state, retry policy, dead-letter inspection, cancellation requests, reassignments, and federated swarm membership. It decides where work may run and records the evidence needed to recover from bounded failures.

The **execution plane** is the existing Helix runtime. A remote `task.submit` is adapted into `HelixRuntime.executeFederatedTask()`, which creates a one-task execution and enters the canonical `runExecution()` → `runTask()` path. That path continues to use the existing `AgentRouter`, `AgentRegistry`, `LeaseScheduler`, `SandboxManager`, `PolicyEngine`, provider abstraction, event store, telemetry, and M10 memory/learning implementation. Remote execution is therefore real in the local deterministic integration tests; it is not a simulated completion callback.

```text
source coordinator
  → capability/trust decision
  → signed task.submit
  → destination inbox and lease/fencing token
  → destination FederationNodeRuntime
  → HelixRuntime.executeFederatedTask
  → existing scheduler → router → worker → sandbox/policy
  → signed task.completed|failed|cancelled
  → source correlation, attempt, and fencing validation
```

## Durable outbox and inbox

`SqliteOutboxStore` and `SqliteInboxStore` use the local `helix.federation.sqlite` database in the runtime data directory. SQLite WAL mode and idempotency keys provide durable local message state. Outbox rows move through `pending`, `sending`, `sent`, and `dead-letter`; rows left in `sending` are reclaimable after restart. Inbox rows prevent duplicate message effects by message ID or idempotency key and retain processing attempts for inspection.

The coordinator sends through the outbox when one is configured, applies bounded exponential retry for idempotent messages, and moves exhausted delivery to the dead-letter queue. `outbox_status`, `outbox_retry`, and `deadletters_list` are exposed through the governed MCP family and corresponding API/CLI surfaces.

> SQLite outbox/inbox persistence is durable **local infrastructure**. It is not distributed consensus, a quorum protocol, a replicated log, or a guarantee that multiple hosts share one authoritative state.

## Leases and fencing

A remote destination acquires a task lease before invoking its runtime. The lease contains an owner, expiry, lease ID, and monotonically increasing fencing token. Renewals and completion require the current token. If a lease expires or is replaced, a stale completion is rejected rather than allowed to overwrite a newer attempt. Retry assigns a new attempt ID; recovery and reassignment remain bounded and explainable.

Lease stores are replaceable, and the current implementation supports in-memory and durable local file/SQLite-adjacent infrastructure. A production deployment still requires a reviewed shared lease authority with clear split-brain behavior. M15 does not claim consensus or Byzantine fault tolerance.

## Authentication and trust boundaries

The default development/test implementation uses HMAC-SHA256 with explicit key IDs. `RotatingHmacKeyProvider` retains the active key and two previous keys, allowing bounded key rotation without accepting unknown key IDs. `KeyProviderMessageSigner` and `KeyProviderMessageVerifier` provide the interface needed for an Ed25519, mTLS, KMS, or managed peer-identity implementation.

Each envelope carries the algorithm, key ID, timestamp, expiry, nonce, source node, destination node, correlation ID, trace ID, schema version, and idempotency key. Verification rejects invalid signatures, unknown key IDs, unsupported algorithms, expired messages, excessive clock skew, and replayed message IDs before handler effects.

Remote dispatch requires explicit `federation:dispatch` permission and a `TRUSTED` or `ADMIN` security context. `UNTRUSTED` and `LIMITED` contexts are rejected for remote execution. Authorization context is copied into the destination task record and the source node is added as provenance; a remote node does not inherit the source node’s local privileges.

## HTTP federation transport

`HttpFederationTransport` targets `/api/v1/federation/messages` by default and sends a bounded JSON body with bearer authentication, message and idempotency headers, an abortable request timeout, explicit status handling, idempotent retries, exponential backoff, and a circuit breaker. The API ingress requires `HELIX_FEDERATION_TOKEN`; signing keys are separately configured through `HELIX_FEDERATION_KEY` and `HELIX_FEDERATION_KEY_ID`.

The in-memory transport remains the deterministic local test adapter. Fault injection can deterministically drop, delay, duplicate, corrupt, partition, or crash message delivery with bounded remaining counts. It is useful for reproducible failure tests and is not a production network substitute.

## Node lifecycle and failure recovery

`FederationNodeRuntime` provides `start`, `stop`, and `status`. Start installs task and cancellation handlers, records a heartbeat, and begins a bounded heartbeat loop. Stop transitions the node to draining, waits up to a configured deadline for active tasks, aborts remaining controllers, records cancellation, stops heartbeats, and marks the node offline. A node that is not ready rejects new tasks.

Network failures can be retried when the message is idempotent. Execution timeouts are distinguished from network timeouts and lease timeouts in the task record and outcome evidence. Failed or cancelled tasks can be retried with a fresh attempt; exhausted outbound messages become dead letters; lease expiry can trigger bounded reassignment to another healthy capability-compatible node. These recovery paths are state-machine operations, not infinite autonomous loops.

## Memory provenance and learning

A successful or failed remote outcome is written through the existing M10 memory backend only after the destination runtime has an assigned agent. The entry is sanitized, ACL-protected, tagged as federation evidence, and includes `sourceNodeId`, task ID, attempt ID, execution ID, agent ID, confidence, and timestamp. Federated learning remains advisory: it can influence bounded routing signals but cannot override capabilities, policy denial, approvals, ACLs, sandbox controls, or lifecycle state.

## Operational surfaces

The API provides federation message ingress, node runtime start/stop/status, outbox and dead-letter inspection, trace inspection, and task cancel/retry routes. The CLI provides `helix federation runtime`, `task dispatch|cancel|retry`, `outbox`, `deadletters`, and `trace` commands. M15 adds ten federation actions to the M14 MCP surface, resulting in **29 federation actions and 225 total registered MCP tools** in the current build.

The reproducible local artifacts are:

```bash
pnpm distributed-runtime:demo
pnpm distributed-runtime:benchmark
node --test dist/tests/federation-milestone-15.test.js
```

The demo uses five nodes, an explicit HMAC fixture, deterministic in-memory transport, 100 simulated agent-routing decisions, a 1,000-task authenticated dispatch simulation, forced delay/crash/cancellation/lease-expiration/sandbox failures, and a 20-task full remote-worker sample. The benchmark reports p50/p95/p99 for transport send, signature verification, outbox enqueue, outbox recovery, lease acquire/release, remote execution, retry overhead, and reassignment, plus measured simulation throughput.

## Limitations and release gates

M15 is production-oriented infrastructure, but the checked-in default remains local-first and deterministic. HMAC is suitable for development and test fixtures, not a complete production key-management policy. The in-memory transport is not multi-host deployment. SQLite outbox/inbox and local lease stores do not provide cross-host authority. The API ingress needs TLS termination, token rotation, rate limiting, and operational isolation. Worker execution still depends on the existing provider and sandbox deployment posture. The demo’s 1,000-task run measures bounded dispatch/completion throughput and does not claim that 1,000 remote tasks were simultaneously executed through 1,000 production workers.

Before production deployment, select and review a managed asymmetric or mTLS trust implementation, a shared lease/outbox authority, durable graph and task snapshots, a production network topology, TLS and secret management, node admission and revocation, chaos and restart testing, resource quotas, observability retention, and an independent security review. No M15 result should be read as a claim of distributed consensus or Byzantine fault tolerance.
