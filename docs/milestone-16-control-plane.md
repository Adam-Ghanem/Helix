# M16 — Production Control Plane and Observability

M16 turns the existing Helix runtime into a coherent operator surface without replacing any M1–M15 subsystem. `ControlPlaneController` composes the real `HelixRuntime`, `AgentRegistry`, `LeaseScheduler`, swarm manager, federation coordinator, memory backend, policy engine, sandbox manager, durable events, and provider boundary into one read model.

## Unified state model

`ControlPlaneSnapshot` contains agents, tasks, workers, swarms, federation nodes, executions, queue/lease state, memory counts and namespaces, policy summary, federation status, and M16 metrics. The snapshot is generated from live component state. It is not a second scheduler, worker pool, cache of authority, or synthetic production view.

The control-plane surface is available through `runtime.controlPlane`, the versioned API under `/api/v1/control/*`, the CLI, governed MCP tools, protected MCP resources, and the static operator dashboard in `apps/dashboard/index.html`.

## Observability

`MetricsRegistry` provides bounded counters, gauges, and histograms. Histograms expose count, sum, min, max, and p50/p95/p99. The registry supports in-memory snapshots, JSON, and Prometheus text export. Runtime event synchronization derives task-completion, task-failure, retry, reassignment, and security-denial counters while snapshots update live queue, worker, agent, federation, and memory gauges.

`EventBus` provides bounded typed events with event IDs, timestamps, correlation and causation IDs, actor/source metadata, recursive secret-like field redaction, subscriptions, unsubscription, and bounded history. Durable runtime events remain authoritative; the bus is a bounded control-plane projection and does not replace the M1 event store.

`ExecutionTraceStore` captures execution identity, hierarchy, stages, decisions, events, errors, metrics, and terminal status. Calling `syncEvents()` projects durable runtime events into traces. Trace data contains structured decision metadata rather than private chain-of-thought and is bounded by a maximum trace count.

## Provider and model routing

The provider layer wraps the existing `ModelProvider` boundary through `RuntimeProviderAdapter`, `ProviderCatalog`, and a deterministic `ModelRouter`. Selection considers requested capability, latency, configured cost, availability, and an explicit private-only filter. The default model is `deterministic-local`. External OpenAI-compatible execution remains opt-in through the existing environment configuration; no external provider is called implicitly, and secrets are never placed in traces, metrics, MCP responses, or control events.

The initial router is deliberately rule-based. It does not invent quality measurements. A future provider can implement the adapter contract for model listing, capabilities, health, execution, and optional streaming while preserving policy and authorization boundaries.

## Sessions

`SessionManager` adds a bounded first-class session record with goal, topology, status, agents, tasks, executions, memory namespace, and lifecycle timestamps. Session execution delegates to `HelixRuntime.execute()` and therefore reuses the M12/M13 orchestration and existing runtime controls. It does not create a second orchestration engine.

## Doctor and health

`Doctor` reports PASS, WARN, or FAIL checks for Node.js, package integrity, SQLite memory, scheduler, worker views, sandbox, Docker availability, MCP boundary, provider configuration, federation transport, signing-key boundary, policy, filesystem access, durable event readability, and outbox/inbox status. Docker absence and the deterministic provider are warnings, not hidden failures. Blocking failures are reserved for checks that prevent a runtime from operating.

## Dashboard and interfaces

The dashboard is a read-only static operator view. It polls the live control API and renders overview cards, agent state, federation nodes, task/execution state, and recent events. It does not ship hardcoded production records. Deterministic demo output is kept in `examples/helix-control-plane-demo.ts`, not in the dashboard.

The CLI exposes:

```text
helix status
helix agents list
helix agents status <id>
helix tasks list|inspect|cancel
helix swarms list|inspect
helix nodes list|status
helix executions list|inspect
helix trace <execution-id>
helix metrics [--prometheus]
helix events tail
helix providers list|status|test
helix doctor
helix session create|list|status|stop|inspect|execute
```

Every read-oriented command supports `--json`. M16 MCP tools are named `helix_control_status`, `helix_control_health`, `helix_control_metrics`, `helix_control_events`, `helix_control_trace`, `helix_control_sessions`, and `helix_control_doctor`. They remain under the existing typed schema, risk, authorization, rate-limit, audit, and error-normalization pipeline. Read-only actors cannot use destructive federation or execution tools.

## Security and failure boundaries

The control plane never bypasses RBAC, the policy engine, memory ACLs, sandbox validation, federation trust, MCP authorization, rate limiting, or audit logging. Control events recursively redact fields such as secret, token, password, API key, and private key. Provider diagnostics expose availability and configuration state, not credential material.

M16 observes worker, provider, sandbox, node, federation, retry, reassignment, restart, and memory behavior already implemented in M1–M15. It does not claim Byzantine fault tolerance, distributed consensus, replicated control-plane state, or kernel-level sandbox isolation. SQLite and the local event store remain local durable infrastructure. The static dashboard requires an API deployment and does not become a distributed authority.

## Evidence and limitations

Run the deterministic benchmark and demo with:

```bash
pnpm control-plane:benchmark
pnpm control-plane:demo
```

The benchmark measures snapshot generation, event dispatch, metric recording, trace creation, agent listing, task listing, provider routing, dashboard/API serialization, and bounded 100-agent/1,000-task status simulations. The demo uses 100 registered agents, multiple swarms, a canonical worker execution, memory learning, an explicitly allowlisted local sandbox command, an intentional bounded execution failure, control-plane metrics/events/traces, and local federation reassignment.

The 100-agent and 1,000-task cases are bounded local status/serialization simulations rather than a claim that one process has concurrently executed 1,000 full worker tasks. External provider tests use deterministic adapters or mocks. Docker and external provider availability are reported by doctor and are not silently assumed.
