# M14 Distributed Orchestration and Federation

M14 extends Helix from a single runtime with autonomous swarms into a distributed orchestration control plane. The implementation is an independent federation adapter over the M1–M13 runtime. It provides explicit node membership, signed task messages, capability-safe routing, replaceable transports, fencing-token leases, remote completion evidence, bounded recovery, and federated swarm membership without creating a second scheduler, worker pool, memory backend, or policy engine.

> **Design principle:** Federation may move an authorized task between Helix nodes, but it may not weaken capability checks, authorization, leases, sandbox policy, memory ACLs, auditability, or durable evidence.

## Scope and package layout

The implementation lives in `packages/federation/src/` and is injected into `HelixRuntime` as `runtime.federation`. The package entry point preserves the earlier `FederationRegistry` signing/replay API while exporting the M14 interfaces and managers.

| Module | Responsibility |
|---|---|
| `types.ts` | Strict node, message, security, routing, lease, task, swarm, transport, worker, metrics, and status contracts |
| `node-registry.ts` | Node identity, endpoint, capability, trust, health, heartbeat, stale detection, and lifecycle transitions |
| `messages.ts` | Injectable HMAC signing/verifying, timestamp/TTL checks, schema checks, and replay protection |
| `transport.ts` | Replaceable transport interface and deterministic in-memory multi-node adapter |
| `router.ts` | Health, load, latency, locality, capability, and trust-aware node selection |
| `leases.ts` | Replaceable lease stores, exclusive acquisition, renewal, release, expiry, and fencing tokens |
| `worker.ts` | Node-aware worker metadata adapter; execution remains owned by the existing runtime worker path |
| `coordinator.ts` | Dispatch, signed remote task handling, completion evidence, recovery, federated swarms, aggregation, and metrics |

M14 intentionally keeps transport and persistence replaceable. The built-in in-memory transport and memory lease store are deterministic test adapters. `FileLeaseStore` supplies a durable local option, but a file does not provide distributed consensus.

## Node membership and health

A node has an explicit identifier, display name, endpoint, role, capabilities, health snapshot, trust level, version, metadata, heartbeat timestamp, and lifecycle status. Valid transitions are guarded rather than freely assignable. A removed node cannot be silently re-registered. Healthy-node selection excludes degraded, draining, offline, and removed nodes before scoring.

Heartbeat refreshes the timestamp and can restore a joining, degraded, or offline node to healthy. A configurable heartbeat timeout marks stale nodes offline while retaining their membership record and evidence. Health scores and load are clamped to the normalized range `0..1`; latency remains an observed millisecond value. Node roles are descriptive routing metadata and do not grant privileges.

## Message contract and transport

Federation messages are versioned envelopes. Each message carries the source node, optional destination node, message type, message ID, correlation ID, trace ID, payload, nonce, creation timestamp, expiry timestamp, schema version, and signature. Task payloads preserve priority, required capabilities, security context, authorization context, title, and input.

The signing boundary is injectable. HMAC signing is provided for deterministic local tests; production deployments must inject a managed key or an asymmetric trust implementation. Verification rejects malformed timestamps, excessive clock skew, expired messages, unknown schema versions, invalid signatures, and replayed message IDs before the message handler mutates state. Replay records are bounded by expiry.

`FederationTransport` exposes `send`, `request`, `subscribe`, and `close`. `InMemoryFederationTransport` delivers targeted or broadcast messages through an explicit shared network and provides bounded request timeouts. A production transport may be implemented around authenticated HTTP, mTLS, a queue, or another reviewed channel, but transport authentication is not assumed by the local adapter.

## Capability-safe routing

`FederationRouter` evaluates only healthy nodes whose capabilities satisfy every required capability. The score combines health, inverse load, bounded latency, trust rank, and locality. The rationale is returned with the selected node so operators can distinguish local preference from a remote decision.

Capability matching is a hard filter, not a score component. Learning, reputation, lower latency, or higher capacity cannot make an incompatible node eligible. The router preserves `local`, `remote`, and `any` locality requirements. Explicit node targets are validated against the same health and capability constraints.

## Distributed leases and fencing

`DistributedLeaseManager` provides exclusive task ownership through a replaceable `LeaseStore`. Every acquisition returns a lease ID, owner node, expiration time, renewal timestamp, and monotonically increasing fencing token per task. A second active acquisition is rejected. Renewal and release require the current lease ID and fencing token. Expiration is explicit and measurable.

Completion paths validate the current lease and token. A stale worker cannot commit after its lease has expired or after a newer owner has acquired a higher fencing token. This protects against delayed messages and duplicate workers, but it does not by itself provide a distributed consensus protocol. Shared production lease authority, clock discipline, and transactional task state remain deployment responsibilities.

## Remote dispatch and recovery

`FederationCoordinator.dispatch()` first performs routing and remote authorization checks. Remote execution requires the `federation:dispatch` permission and a trust level above `UNTRUSTED`; otherwise the request fails rather than silently downgrading to local or remote execution. A local dispatch acquires an existing coordinator lease. A remote dispatch creates a signed `task.submit` message.

The receiving coordinator verifies the envelope, rejects duplicate task IDs, acquires its local distributed lease, records the task, and returns signed acceptance evidence. Completion or failure is returned with the correlation ID, trace ID, and fencing token. The source updates its task record only when the evidence matches the expected correlation and token. Remote nodes receive no inherited local privileges.

Recovery is bounded. Lease expiry changes affected task evidence to a failure state. `recover()` can route an expired task to another eligible healthy node. `handoff()` and `rebalance()` select only compatible targets and record reassignment evidence. A production worker adapter should invoke the existing Helix scheduler, worker, sandbox, and policy path at the target node; the federation package does not execute arbitrary commands itself.

## Federated swarms

A federated swarm contains a bounded list of node IDs, a topology label, a trust level, a maximum node count, and task membership. Nodes are added only after registry validation and cannot exceed `maxNodes`. A swarm can delegate a capability-constrained task to an eligible member, transition to running, aggregate explicit task results, and stop. Missing results are not fabricated.

Federated swarms complement M13 agent-level swarms. M13 remains responsible for local role formation, topology adaptation, health, handoffs, consensus, and agent-level learning. M14 adds the node-level boundary around that swarm, allowing a task or swarm member to be placed on another Helix runtime while preserving authorization and evidence.

## Security boundaries

| Boundary | M14 behavior |
|---|---|
| Remote execution | Default-deny; requires explicit `federation:dispatch` and trusted context |
| Capability matching | Hard filter before routing or dispatch |
| Message integrity | Injectable signer/verifier; invalid, expired, unknown-version, and replayed messages rejected |
| Replay | Message ID remembered until expiry; duplicate task IDs are rejected at the receiver |
| Lease safety | Exclusive ownership, renewal checks, release checks, and fencing-token validation |
| Privilege propagation | Authorization context is preserved; local privileges are never inherited remotely |
| Policy and sandbox | Existing policy engine and sandbox remain authoritative at execution time |
| Memory | Existing namespace ACL, owner, visibility, provenance, and sanitization rules remain authoritative |
| Audit | Coordinator emits durable event evidence through the runtime event sink; MCP adds sanitized audit records |
| External operations | No cloud, browser, GitHub, or LLM call is made by the deterministic adapters |

Secrets are not embedded in source. Test and demo keys are explicitly injected fixtures. A production deployment needs a secret manager, key rotation, peer identity validation, endpoint authentication, TLS or mTLS, and audit review.

## External surfaces

The API exposes node listing and registration, node status, heartbeat, drain, removal, federation status, metrics, lease listing, task dispatch, and task status. The CLI exposes `helix federation doctor`, `nodes`, `node register|drain|remove`, `status`, `metrics`, `dispatch`, and `leases` with JSON output support.

The MCP adapter extends the existing federation family with governed node, heartbeat, task dispatch, task status, lease, metrics, message verification, and trust inspection actions. Federation resources expose nodes, status, and metrics. Recovery and security prompts describe safe operational checks without exposing private chain of thought. All operations pass through the existing MCP actor authorization, risk classification, rate limiting, sanitized audit, and error normalization pipeline.

## Verification and measured benchmark

The M14 test suite contains 26 deterministic scenarios covering registration, heartbeat, stale-node detection, capability routing, lease conflicts, renewal, expiration, fencing, message signing, invalid signatures, replay, schema rejection, remote acceptance and completion, failure evidence, node disappearance, reassignment, federated swarm aggregation, trust boundaries, context preservation, 100-agent simulation, network failure, duplicate transport, metrics, and replay-store cleanup. MCP regression tests additionally cover tool registration and viewer denial of remote dispatch.

The benchmark command is:

```bash
pnpm federation:benchmark
```

It measures node registration, heartbeat, HMAC verification, capability routing, lease acquire/release, remote dispatch, reassignment, 100-agent scheduling, and 1,000 routing decisions. The benchmark reports average, p50, p95, and p99 values where repeated samples exist, together with throughput and federation metrics. It is a local observation and must not be interpreted as a production capacity promise.

The demonstration command is:

```bash
pnpm federation:demo
```

The demo provisions five nodes and 100 workers, distributes 1,000 tasks with 80% remote placement, completes the tasks through signed in-memory messages, expires two explicit leases, marks nodes offline, performs rebalancing and handoff, forms a five-node federated swarm, aggregates explicit results, and prints security and metric evidence. It performs no LLM or cloud operation.

## Limitations and release gates

M14 is a production-oriented contract and local reference adapter, not a claim that distributed deployment is complete. The current implementation does not provide Byzantine fault tolerance, quorum consensus, a production authenticated network transport, shared multi-host graph or snapshot persistence, a distributed outbox, a consensus-backed lease authority, or a cloud autoscaling controller. The in-memory transport is intentionally process-local. The file lease store is durable on one filesystem but is not safe as a multi-host authority without additional coordination.

Before production release, Helix still requires authenticated transport and peer identity, TLS or mTLS, secret-manager and key-rotation integration, shared lease and outbox design, transactionally durable task state, idempotent cross-node event delivery, worker-process chaos testing, node partition and clock-skew tests, graph/snapshot persistence, OpenTelemetry exporters, backup and restore review, Docker and kernel hardening, and independent security review of application-level consensus assumptions.
