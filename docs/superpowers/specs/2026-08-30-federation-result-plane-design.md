# Helix Federation Result Plane Design

## Goal

Upgrade Helix federation from an in-memory node registry/signature helper into a durable node-to-node task/result plane with authenticated envelopes, replay protection, capability-aware routing, idempotency, bounded HTTP transport, and restart recovery.

## Architecture

- Preserve `FederationRegistry` for compatibility and signing primitives.
- Add `DurableFederationState` for nodes, received message ids/nonces, inbound tasks, outbound tasks, and results using serialized atomic JSON replacement.
- Add `FederationHttpServer` using Node `http` with bounded JSON bodies and endpoints `/v1/heartbeat`, `/v1/tasks`, `/v1/results`.
- Add `FederationClient` using `fetch` with timeout, signed envelopes, idempotency keys, and bounded retry for transient HTTP failures.
- Add `FederationRouter` to select an online non-quarantined node satisfying all required capabilities, preferring fresher heartbeats and lower active load.

## Security

- Every task/result/heartbeat is a signed `FederationMessage` and must target the receiving node id.
- Signature verification uses HMAC SHA-256 and constant-time comparison.
- Reject expired, replayed, duplicate nonce, malformed, oversized, or wrong-recipient messages.
- Mark message id + nonce durable before acknowledging delivery so restart cannot re-enable replay.
- Do not claim TLS identity: HTTP is supported for local/test deployment; production configuration can require HTTPS endpoints.
- Payload size defaults to 1 MiB and is configurable downward/upward within a hard 16 MiB ceiling.
- No remote shell/code execution is part of this plane; tasks are structured orchestration payloads consumed by a separate worker handler.

## Data Contracts

`FederatedTask` contains `id`, `executionId`, `taskType`, `goal`, `requiredCapabilities`, `payload`, `createdAt`, `status`, `attempt`, and optional `assignedNodeId`.

`FederatedResult` contains `id`, `taskId`, `executionId`, `nodeId`, `success`, `output`, optional `error`, and `createdAt`.

`DurableFederationState` supports `init`, node upsert/heartbeat/list, `acceptMessage`, enqueue/list/update tasks, append/get results, and load counters.

## HTTP Behavior

- `POST /v1/heartbeat`: verify envelope, update sender heartbeat/capabilities/load, return `{ok:true}`.
- `POST /v1/tasks`: verify envelope, durably insert task once, call optional `onTask(task)`, return `202` with task id; idempotent duplicates return prior acceptance without rerunning handler.
- `POST /v1/results`: verify envelope, durably insert result once, return `202`.
- Invalid signatures/replay/wrong recipient return `401`; expired envelope returns `408`; invalid payload returns `400`; oversized body returns `413`.

## Client Behavior

Client signs with the local node id and target node id. It has `heartbeat`, `submitTask`, and `submitResult`. Retries only network errors, 408, 425, 429, and 5xx, reusing the same signed envelope/idempotency identity so the server can deduplicate.

## Verification

TDD integration tests use two local HTTP servers to verify real signed task delivery, result return, duplicate idempotency, tamper/replay rejection, expiry, wrong recipient rejection, capability routing, and durable restart replay protection.