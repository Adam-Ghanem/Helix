# Helix

> **Coordinate Intelligence.**

Helix is an autonomous multi-agent operating system and orchestration runtime. The core principle is that the LLM is a replaceable component: Helix owns execution state, scheduling, permissions, recovery, coordination, observability, and durable evidence.

## What is implemented in v0.1

This repository contains a runnable vertical slice rather than a non-functional mock. It includes an append-only durable event store with replay and snapshots, idempotent event handling, a validated task-DAG engine, pluggable routing strategies, policy evaluation with approval gates, resource budgets, a lease-based local scheduler, structured cognition metadata, agent health and reputation tracking, a provider-neutral runtime, lifecycle controls for pause/resume/cancel/retry/checkpoint/recovery, a policy-backed local and Docker execution sandbox with audit logging, a bounded and optionally authenticated HTTP API, a JSON-capable CLI, a TypeScript SDK, a dashboard shell, and unit/integration tests.

The default runtime uses a local JSONL event log so it can run without Docker or an external database. The persistence interfaces are intentionally provider-neutral; PostgreSQL, Redis, vector databases, graph databases, MCP transports, and federated nodes are declared as extension points and are not represented as complete implementations in this release. Sandbox execution is now available through a real local backend and an optional Docker backend; local mode provides process and policy controls but is not equivalent to container isolation.

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

To use a real OpenAI-compatible provider, set `HELIX_MODEL_API_URL`, `HELIX_MODEL_API_KEY`, and `HELIX_MODEL`. When all three are present, both the API and CLI use the bounded HTTP adapter with request timeouts and usage accounting. If they are absent, Helix intentionally uses the deterministic local provider.

## Repository map

| Area | Purpose | Status |
|---|---|---|
| `packages/core` | Versioned domain objects and IDs | Implemented |
| `packages/durable` | Event log, replay, snapshots, idempotency | Implemented |
| `packages/planner` | Validated task DAGs and mutation | Implemented |
| `packages/router` | Capability, weighted, quality, cost, latency, hybrid routing | Implemented |
| `packages/policy` | Default-deny policy decisions and approvals | Implemented |
| `packages/scheduler` | Durable local leases and recovery hooks | Implemented |
| `packages/runtime` | Observe–interpret–plan–act–evaluate lifecycle, lifecycle controls, memory, telemetry | Implemented |
| `packages/agents` | Built-in catalog, health, reputation | Implemented |
| `packages/memory` | Access-controlled structured memory and deterministic search | Implemented |
| `packages/tools` / `packages/mcp` | Tool schema registry and MCP security boundary | Implemented boundary |
| `packages/workflows` | Versioned declarative workflow DAGs | Implemented |
| `packages/swarm` / `packages/consensus` | Swarm topology planning and consensus strategies | Implemented |
| `packages/knowledge` | Provenance-aware graph entities and relations | Implemented |
| `packages/observability` | Correlated spans, metrics, and structured logs | Implemented |
| `packages/evaluation` | Rule, schema, test, human, and non-authoritative LLM-judge evaluation contracts | Implemented |
| `packages/learning` | Trajectory evidence and reusable strategy/tool patterns | Implemented |
| `packages/security` / `packages/sandbox` | RBAC, secret metadata, canonical paths, command allowlists, environment filtering, local process controls, Docker isolation, lifecycle management, and audit log | M8 implemented; deployment hardening and Docker daemon policy remain |
| `packages/plugins` / `packages/providers` | Plugin trust and provider/model capability discovery | Implemented foundations |
| `packages/federation` | Signed messages, replay protection, node registry, heartbeat | Implemented foundation |
| `packages/sdk` | TypeScript client for execution, lifecycle, memory, telemetry, approvals | Implemented |
| `apps/api` | Versioned HTTP API | Implemented |
| `apps/cli` | Professional CLI with JSON output | Implemented |
| `apps/dashboard` | Read-only dashboard shell | Boundary documented |

## Security posture

The policy engine defaults to deny. Tool calls are represented as auditable requests and cannot execute until an explicit policy decision allows them or a human approval is recorded. Helix stores structured decision metadata, not private chain-of-thought. Secrets are not accepted as ordinary execution state.

This repository is not a production security certification. Before deployment, run the security test matrix, supply a real secret provider, place the API behind TLS and authentication, and replace the local event log with a reviewed durable store appropriate to the deployment scale.

## Validation

```bash
pnpm typecheck
pnpm build
pnpm test
```

Sandbox controls are available through the CLI:

```bash
helix sandbox doctor --json
helix sandbox run --timeout 10s --memory 512 --network none -- node script.js
helix sandbox status --json
helix sandbox destroy <sandbox-id> --json
```

The API exposes `GET /api/v1/sandboxes`, `GET /api/v1/sandboxes/:id`, and `POST /api/v1/sandboxes/:id/destroy`. Execution creation can include a typed `sandbox` request. Docker mode defaults to a read-only root, non-root user, dropped capabilities, no network, workspace-only read/write mount, PID/memory/CPU limits, and deterministic cleanup. The local backend explicitly reports unsupported kernel-level isolation limits.

Lifecycle controls are available through the CLI and API:

```bash
helix execution <execution-id> pause
helix execution <execution-id> resume
helix execution <execution-id> cancel
helix execution <execution-id> retry
helix execution <execution-id> checkpoint
```

The runtime persists lifecycle events and can rehydrate completed executions from the event log. `helix recover` is planned as a daemon command; the runtime recovery API is currently exposed through the SDK and application layer.

Measured benchmark output is written by `node benchmarks/runtime.mjs` or `pnpm benchmark` and is never hard-coded into documentation. The golden flow is available through `pnpm golden-demo`, and the sandbox flow is available through `pnpm sandbox-demo`. See [`docs/milestone-8-sandbox.md`](docs/milestone-8-sandbox.md) for backend guarantees and deployment limitations.

## M9 intelligence and persistent memory

M9 adds a local-first learning loop around the existing runtime. Helix now supports typed `MemoryEntry` records, global/agent/swarm/task/session namespaces, ACL enforcement, provenance, confidence, deterministic hybrid search, configurable decay, sanitized outcome persistence, idempotent learning events, agent experience, and bounded routing hints. The learning bonus is capped at 10% and cannot override required capability matching.

Memory and learning commands are available through the CLI:

```bash
helix memory search "authentication TypeScript"
helix memory list
helix memory inspect <memory-id>
helix memory stats
helix learning agent <agent-id>
helix learning hints "authentication debugging"
```

The API exposes `GET/POST /api/v1/memory`, `GET/DELETE /api/v1/memory/:id`, `GET /api/v1/memory/search`, `GET /api/v1/learning/hints`, `GET /api/v1/learning/agent/:agentId`, and `POST /api/v1/learning/outcome`. Governed MCP registration exposes `helix.memory.search`, `helix.memory.get`, `helix.memory.list`, `helix.memory.stats`, `helix.learning.recall`, `helix.learning.routingHints`, and `helix.learning.agentExperience`.

Run the deterministic 100-agent/1,000-task simulation and measured comparison with:

```bash
pnpm memory-demo
pnpm memory-benchmark
```

The deterministic embedding provider is a local testing abstraction, not a production neural semantic model. The default JSONL backend is local-first and can later be replaced behind the storage and embedding interfaces. See [`ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/milestone-9-memory-learning.md`](docs/milestone-9-memory-learning.md), and [`docs/architecture.mmd`](docs/architecture.mmd).

## License

Apache-2.0. Independent implementation. Helix does not copy source code, branding, or proprietary architecture from other projects.
