# Helix Control Plane Reference

## Purpose

The Helix control plane is a read-oriented operational composition layer. It provides one consistent view over the authoritative runtime components and exposes bounded controls through the API, CLI, MCP, and dashboard. It does not become a new execution authority.

> **Control plane:** state projection, lifecycle requests, diagnostics, routing explanations, metrics, traces, and operator interfaces over the existing Helix runtime.

> **Execution plane:** the existing scheduler, worker/provider path, sandbox, policy engine, memory/learning, and federation runtime that perform governed work.

## State authority

| Domain | Authoritative component | Control-plane view |
|---|---|---|
| Agents | `AgentRegistry` | profiles, status, capabilities, health, reputation |
| Tasks and executions | `HelixRuntime` and `TaskGraph` | task records, execution records, result/error state |
| Leases and queue | `LeaseScheduler` | queue depth, active leases, worker utilization |
| Swarms | `DynamicSwarmManager` | topology, members, lifecycle and health |
| Federation | `FederationCoordinator` and `NodeRegistry` | node health, trust, tasks, leases and transport metrics |
| Memory and learning | M10 `MemoryBackend` and learning engine | count, namespaces, cache size and event evidence |
| Policy and sandbox | existing `PolicyEngine` and `SandboxManager` | denial/approval summaries and execution evidence |
| Events | durable `EventStore` | bounded typed event projection and traces |
| Provider/model | existing `ModelProvider` plus `ProviderRegistry` | configured health and deterministic route decisions |

## API

All control routes are versioned under `/api/v1/control` and inherit the existing API authentication and rate-limiting behavior.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/status` | unified `ControlPlaneSnapshot` |
| `GET` | `/health` | component health with PASS/WARN/FAIL |
| `GET` | `/metrics` | JSON metrics snapshot |
| `GET` | `/metrics?format=prometheus` | Prometheus text adapter |
| `GET` | `/events` | bounded event projection |
| `GET` | `/traces` | bounded trace list |
| `GET` | `/traces/:executionId` | execution trace inspection |
| `GET` | `/providers` | configured provider health |
| `POST` | `/models/route` | deterministic model-route decision |
| `GET` | `/doctor` | diagnostic report |
| `GET/POST` | `/sessions` | list or create sessions |
| `GET` | `/sessions/:id` | inspect session |
| `POST` | `/sessions/:id/start|stop|execute` | bounded session lifecycle |

## Metrics

`MetricsRegistry` is intentionally dependency-free and bounded. Counters represent monotonic occurrences, gauges represent current state, and histograms retain only the configured sample window. JSON and Prometheus output are adapters; Prometheus is not required for local operation.

Typical metric names include `tasks.completed`, `tasks.failed`, `tasks.retried`, `tasks.reassigned`, `security.denied`, `agents.available`, `workers.active`, `tasks.queue_depth`, `federation.nodes_healthy`, and `memory.entries`. Applications can add task execution, provider, sandbox, federation, and lookup histograms at their existing instrumentation points.

## Event and trace model

The typed event bus carries event ID, timestamp, correlation ID, optional causation ID, actor, source, and sanitized metadata. Subscribers receive a copy of the bounded event record; unsubscription is explicit. The bus projects durable event-store records and does not replace the durable event log.

Traces contain stage transitions, structured routing decisions, linked events, errors, and measurements. Explanations must remain evidence-oriented. Helix deliberately does not expose or persist private chain-of-thought.

## Security

The API, CLI, MCP, and dashboard are adapters over existing security boundaries. Remote federation mutations remain governed by the M15 trust and authorization checks. MCP control tools are read-only and are still subject to the existing actor role, risk, rate-limit, audit, and error normalization model. Provider diagnostics reveal only safe status metadata. Event metadata recursively redacts secret-like fields.

The control-plane snapshot is not a security decision. Any operation that changes execution, policy, memory, sandbox, or federation state must pass through its original authoritative component.

## Operational modes

| Mode | Status | Notes |
|---|---|---|
| Local deterministic runtime | Implemented | default provider; no external network call |
| M16 control API/CLI/MCP | Implemented | authenticated or role-governed adapters |
| Static dashboard | Implemented | live read-only polling view; requires API |
| JSON/Prometheus metrics | Implemented | in-memory bounded registry |
| SQLite/M10 memory | Implemented | existing durable local backend |
| OpenAI-compatible provider | Production adapter | opt-in only with explicit endpoint/key/model configuration |
| Docker sandbox | Production adapter | availability must be checked; local sandbox has weaker isolation |
| Shared distributed control state | Future work | SQLite/event files are not replicated consensus |
| Byzantine consensus | Not implemented | no claim is made |

## Running the operator surface

```bash
pnpm dev:api
# serve apps/dashboard/ through a static server and point localStorage.HELIX_API at the API origin
helix status --json
helix metrics --prometheus
helix events tail --json
helix doctor --json
helix providers status --json
```

For deterministic evidence:

```bash
pnpm control-plane:benchmark
pnpm control-plane:demo
```
