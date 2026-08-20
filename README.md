# Helix

> **Coordinate Intelligence.**

Helix is an autonomous multi-agent operating system and orchestration runtime. The core principle is that the LLM is a replaceable component: Helix owns execution state, scheduling, permissions, recovery, coordination, observability, and durable evidence.

## What is implemented in v0.1

This repository contains a runnable vertical slice rather than a non-functional mock. It includes an append-only durable event store with replay and snapshots, idempotent event handling, a validated task-DAG engine, pluggable routing strategies, policy evaluation with approval gates, resource budgets, a lease-based local scheduler, structured cognition metadata, agent health and reputation tracking, a provider-neutral runtime, lifecycle controls for pause/resume/cancel/retry/checkpoint/recovery, a bounded and optionally authenticated HTTP API, a JSON-capable CLI, a TypeScript SDK, a dashboard shell, and unit/integration tests.

The default runtime uses a local JSONL event log so it can run without Docker or an external database. The persistence interfaces are intentionally provider-neutral; PostgreSQL, Redis, vector databases, graph databases, MCP transports, and federated nodes are declared as extension points and are not represented as complete implementations in this release.

## Quick start

```bash
pnpm install
pnpm verify
pnpm dev:api
```

In another shell:

```bash
pnpm dev:cli run "Review this repository architecture"
# or
pnpm dev:cli run "Review this repository architecture" --json
```

The API listens on `http://127.0.0.1:8787` by default. Set `HELIX_DATA_DIR` to choose the durable data directory and `HELIX_PORT` or `HELIX_HOST` to change the listener. For non-local access, set `HELIX_API_KEY`; all routes except `/api/v1/health` then require `Authorization: Bearer <key>`. Request bodies are bounded and a per-client request rate limit is enforced.

## Repository map

| Area | Purpose | Status |
|---|---|---|
| `packages/core` | Versioned domain objects and IDs | Implemented |
| `packages/durable` | Event log, replay, snapshots, idempotency | Implemented |
| `packages/planner` | Validated task DAGs and mutation | Implemented |
| `packages/router` | Capability, weighted, quality, cost, latency, hybrid routing | Implemented |
| `packages/policy` | Default-deny policy decisions and approvals | Implemented |
| `packages/scheduler` | Durable local leases and recovery hooks | Implemented |
| `packages/runtime` | Observe–interpret–plan–act–evaluate lifecycle | Implemented |
| `packages/agents` | Built-in catalog, health, reputation | Implemented |
| `packages/sdk` | TypeScript client | Implemented |
| `apps/api` | Versioned HTTP API | Implemented |
| `apps/cli` | Professional CLI with JSON output | Implemented |
| `apps/dashboard` | Read-only dashboard shell | Boundary documented |
| `packages/mcp`, `federation`, `sandbox` | Secure integration boundaries | Interfaces and policy hooks only |

## Security posture

The policy engine defaults to deny. Tool calls are represented as auditable requests and cannot execute until an explicit policy decision allows them or a human approval is recorded. Helix stores structured decision metadata, not private chain-of-thought. Secrets are not accepted as ordinary execution state.

This repository is not a production security certification. Before deployment, run the security test matrix, supply a real secret provider, place the API behind TLS and authentication, and replace the local event log with a reviewed durable store appropriate to the deployment scale.

## Validation

```bash
pnpm typecheck
pnpm build
pnpm test
```

Lifecycle controls are available through the CLI and API:

```bash
helix execution <execution-id> pause
helix execution <execution-id> resume
helix execution <execution-id> cancel
helix execution <execution-id> retry
helix execution <execution-id> checkpoint
```

The runtime persists lifecycle events and can rehydrate completed executions from the event log. `helix recover` is planned as a daemon command; the runtime recovery API is currently exposed through the SDK and application layer.

Measured benchmark output is written by `helix benchmark` and is never hard-coded into documentation.

## License

Apache-2.0. Independent implementation. Helix does not copy source code, branding, or proprietary architecture from other projects.
