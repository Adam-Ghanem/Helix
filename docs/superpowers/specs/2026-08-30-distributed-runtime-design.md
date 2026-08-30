# Distributed Runtime / Multi-node Swarm Execution Design

## Goal

Turn the existing federation transport into a durable distributed execution plane that can schedule work across healthy nodes, fence stale workers, survive coordinator restart, and take over abandoned work without accepting late results from an old attempt.

## Scope

This tranche adds four tightly coupled capabilities:

1. **Durable remote leases with attempt fencing**
   - Each remote dispatch receives a durable lease id and monotonically increasing task attempt.
   - A result is accepted only when `taskId`, `nodeId`, `leaseId`, and `attempt` match the currently active lease.
   - Late results from expired/superseded attempts fail closed.

2. **Durable node health**
   - Heartbeats update `lastHeartbeat`, `load`, and online status in federation state.
   - Nodes whose heartbeat is older than a configured timeout are marked offline before routing.

3. **Node-aware distributed coordinator**
   - Queued federation tasks are routed only to healthy nodes with all required capabilities.
   - Routing keeps the existing load-first / heartbeat-freshness ordering.
   - Dispatch failures do not silently move ownership; the active lease remains authoritative until expiry.
   - Recovery expires stale leases, requeues abandoned tasks, then permits takeover by another healthy node.

4. **Signed heartbeat transport**
   - The HTTP federation plane accepts signed heartbeat messages using the existing HMAC envelope and replay protection.
   - Heartbeat payloads advertise endpoint, capabilities, and current load.

## Architecture

The coordinator remains single-writer for one local federation state file. Remote workers may execute the same logical task only if the coordinator issued a lease for that specific attempt. The origin state is authoritative for result acceptance. Remote nodes persist their execution/result locally for idempotent HTTP retries, but only the origin coordinator can commit a leased result into the authoritative task state.

A lease expiry is a fencing boundary: after recovery increments the next attempt, an old node can still send a signed response, but the origin state rejects it because its lease id/attempt no longer matches.

## State model

Add `FederationLease`:

```ts
interface FederationLease {
  id: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: number;
}
```

Extend `FederationTask` with optional `leaseId` so leased tasks carry their fencing token over the network.

Extend `FederationResult` with `attempt` and optional `leaseId`. Legacy non-leased federation calls remain supported; leased result commit uses strict fencing.

Persist leases in federation state and migrate version-1 state by treating missing leases as an empty set.

## Failure semantics

- A task with an active unexpired lease cannot be leased by another node.
- `recoverExpiredLeases(now)` removes expired leases and requeues unfinished tasks without deleting audit/result data.
- A committed success/failure result finalizes the task and removes its active lease.
- A stale result from an expired or superseded lease is rejected and does not mutate task status or durable results.
- A transport error alone does not release a lease early; this avoids duplicate concurrent execution after an ambiguous network failure.
- Max attempts are enforced by the coordinator before a new lease is acquired.

## Health semantics

- `heartbeatNode()` persists endpoint/capabilities/load/lastHeartbeat and sets status `online` unless the node is quarantined.
- `expireStaleNodes(timeoutMs, now)` changes stale online nodes to `offline`.
- Quarantined nodes are never revived by a heartbeat without explicit upsert/status change.
- Routing only considers online nodes with a heartbeat inside the configured timeout.

## Network protocol additions

`POST /v1/federation/heartbeat`

Signed payload:

```ts
{
  kind: 'heartbeat',
  node: {
    id,
    endpoint,
    capabilities,
    status: 'online',
    lastHeartbeat,
    load
  }
}
```

The receiver validates signature, recipient, replay/expiry, and `message.from === node.id`, then persists the heartbeat and returns a signed `heartbeat-ack` envelope.

Existing `POST /v1/federation/task` remains compatible. When the dispatched task contains `leaseId`, the returned result carries the same `leaseId` and `attempt`.

## Coordinator API

Add `DistributedRuntimeCoordinator` under `packages/federation/src/runtime.ts` with:

```ts
submit(input): Promise<FederationTask>
runTask(taskId: string): Promise<FederationResult>
runPending(): Promise<FederationResult[]>
recover(now?: number): Promise<{ recoveredLeases: FederationLease[]; results: FederationResult[] }>
heartbeatNode(node): Promise<FederationNode>
```

Options include durable state, HTTP client, router override, `leaseMs`, `heartbeatTimeoutMs`, and `maxAttempts`.

## Compatibility constraints

- Existing legacy federation HTTP dispatch tests must keep passing.
- Existing state files with `version: 1` must load successfully.
- Existing `FederationRouter.select(nodes, capabilities, now)` behavior stays valid.
- No global database, consensus protocol, or multi-writer state replication is introduced in this tranche.
- Do not claim cross-region exactly-once execution; this provides at-least-once execution with coordinator-side fenced result commitment.
