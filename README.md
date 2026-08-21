# Helix

> **Coordinate Intelligence.**

Helix is an autonomous multi-agent operating system and orchestration runtime. The core principle is that the LLM is a replaceable component: Helix owns execution state, scheduling, permissions, recovery, coordination, observability, and durable evidence.

## What is implemented in v0.1

This repository contains a runnable vertical slice rather than a non-functional mock. It includes an append-only durable event store with replay and snapshots, idempotent event handling, a validated task-DAG engine, pluggable routing strategies, policy evaluation with approval gates, resource budgets, a lease-based local scheduler, structured cognition metadata, agent health and reputation tracking, a provider-neutral runtime, lifecycle controls for pause/resume/cancel/retry/checkpoint/recovery, a policy-backed local and Docker execution sandbox with audit logging, a bounded and optionally authenticated HTTP API, a JSON-capable CLI, a TypeScript SDK, a dashboard shell, and unit/integration tests.

The default runtime uses a local JSONL event log for execution events and a transactional SQLite memory database for durable intelligence, so it can run without Docker or a remote database. The persistence interfaces remain provider-neutral; PostgreSQL, Redis, remote vector databases, graph databases, MCP transports, and federated nodes are declared as extension points and are not represented as complete implementations in this release. Sandbox execution is available through a real local backend and an optional Docker backend; local mode provides process and policy controls but is not equivalent to container isolation.

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
| `packages/memory` | Access-controlled structured memory, SQLite/JSONL persistence, indexes, cache, bounded hybrid search, and compaction | M10 implemented; remote vector/database adapters remain |
| `packages/tools` / `packages/mcp` | Tool schema registry and MCP security boundary | Implemented boundary |
| `packages/workflows` | Versioned declarative workflow DAGs | Implemented |
| `packages/swarm` / `packages/consensus` | Swarm topology planning and consensus strategies | Implemented |
| `packages/knowledge` | Provenance-aware graph entities and relations | Implemented |
| `packages/observability` | Correlated spans, metrics, and structured logs | Implemented |
| `packages/evaluation` | Rule, schema, test, human, and non-authoritative LLM-judge evaluation contracts | Implemented |
| `packages/learning` | Durable outcomes, bounded routing hints, agent experience, async queue, and batch persistence | M10 implemented; production distributed queue remains |
| `packages/security` / `packages/sandbox` | RBAC, secret metadata, canonical paths, command allowlists, environment filtering, local process controls, Docker isolation, lifecycle management, and audit log | M8 implemented; deployment hardening and Docker daemon policy remain |
| `packages/plugins` / `packages/providers` | Plugin trust and provider/model capability discovery | Implemented foundations |
| `packages/federation` | Signed messages, replay protection, node registry, heartbeat, capability-safe routing, distributed leases, transports, recovery, and federated swarms | M14 implemented; production multi-host persistence and transport deployment remain |
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

Measured benchmark output is written by `node benchmarks/runtime.mjs` or `pnpm benchmark` and is never hard-coded into documentation. The golden flow is available through `pnpm golden-demo`, the sandbox flow is available through `pnpm sandbox-demo`, and the M10 memory comparison is available through `pnpm memory-benchmark`. See [`docs/milestone-8-sandbox.md`](docs/milestone-8-sandbox.md) for backend guarantees and deployment limitations.

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

The deterministic embedding provider is a local testing abstraction, not a production neural semantic model. M10 uses `better-sqlite3` with WAL mode, transactional batch writes, namespace/agent/task/type/tag/timestamp/confidence indexes, an FTS5 candidate index, bounded retrieval, an LRU/TTL cache, JSONL migration support, and compaction. Set `useSqliteMemory: false` only when explicitly retaining the M9 JSONL backend for compatibility. Learning writes are asynchronous by default in the runtime and can be awaited through `flushLearning()`; direct learning APIs remain deterministic. See [`ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/milestone-9-memory-learning.md`](docs/milestone-9-memory-learning.md), [`docs/milestone-10-production-memory.md`](docs/milestone-10-production-memory.md), and [`docs/architecture.mmd`](docs/architecture.mmd).

## M10 production memory and fast intelligence

M10 addresses the M9 retrieval bottleneck with a real transactional SQLite backend. The SQLite store uses WAL mode, indexed namespace/agent/swarm/task/type/timestamp/confidence columns, normalized tag indexes, FTS5 lexical candidate retrieval, bounded hybrid scoring, a TTL/LRU cache, batched learning persistence, duplicate-pattern compaction, optional expired-record cleanup, `VACUUM`, and one-time JSONL migration support. Existing M9 JSONL behavior remains available as an explicit compatibility backend.

The runtime defaults to SQLite memory and queues outcome learning asynchronously so task execution does not wait for persistent learning writes. The queue deduplicates replay keys, drains in bounded batches, and exposes an explicit flush operation. This is an in-process bounded queue, not a distributed delivery guarantee.

Run the M10 benchmark with:

```bash
pnpm memory-benchmark
```

The benchmark uses 100 agents, 1,000 tasks, and 10,000 seeded memories. It reports routing latency, memory lookup latency with p50/p95/p99, write latency with p50/p95/p99, throughput, task completion, CPU, heap delta, and measured deltas. The benchmark must be treated as a local deterministic measurement rather than a production capacity promise.

## M11 full MCP ecosystem

M11 adds an official `@modelcontextprotocol/sdk` adapter over existing Helix capabilities. The server registers **215 unique typed tools** across agents, tasks, scheduler, workers, swarm, memory, learning, sandbox, security, policy, providers, models, workflows, evaluation, federation, system, GitHub boundary, filesystem, browser boundary, events, and intelligence families. Each tool has a unique name, Zod input schema, family, risk classification, permissions, deterministic error category, authorization check, rate-limit bucket, and sanitized audit record.

The server also exposes sixteen protected resources and twelve policy-aware prompts. Supported transports are official SDK stdio and Streamable HTTP:

```bash
helix mcp doctor --json
helix mcp tools --json
helix mcp resources --json
helix mcp prompts --json
helix mcp serve
pnpm mcp:serve:http
```

The Streamable HTTP endpoint binds to `http://127.0.0.1:8790/mcp` by default. Claude Code can register the local server with `claude mcp add helix -- pnpm --dir /path/to/Helix mcp:serve`. The default MCP actor is read-only; writes, sandbox execution, administrative policy operations, and remote federation operations require stronger roles or remain denied by default. GitHub and browser families report an explicit unconfigured boundary rather than making hidden external calls. See [`docs/milestone-11-mcp.md`](docs/milestone-11-mcp.md) for the tool-family inventory, resources, prompts, transport details, benchmark, and limitations.

## M12 autonomous intelligence

M12 adds a deterministic autonomous orchestration layer above the existing runtime. A goal is analyzed into category, capabilities, complexity, risk, topology, dependencies, and expected agent types; a bounded category-aware planner creates a typed task plan; validation checks cycles, dependencies, capability satisfiability, topology, and security constraints; the existing router selects compatible agents; and the existing scheduler, workers, sandbox, memory, and learning components remain authoritative during execution.

The orchestration lifecycle is durable and explainable: `CREATED → ANALYZING → PLANNING → VALIDATING → READY → RUNNING → EVALUATING`, with bounded replanning and terminal `COMPLETED`, `FAILED`, or `CANCELLED` states. High- and critical-risk plans require explicit authorization. Learning hints are advisory and bounded at ten percent; they cannot override capability mismatches, policy denial, approval requirements, memory ACLs, or sandbox controls. All autonomous loops are bounded by retry, replan, iteration, task-count, depth, and fan-out limits.

Use the new CLI surfaces as follows:

```bash
helix goal create --title "Build a reporting module" --description "Implement and test a reliable reporting module"
helix goal analyze <goal-id>
helix plan create <goal-id>
helix plan validate <plan-id>
helix plan show <plan-id>
helix orchestrate --title "Document the benchmark" --description "Write and review a concise benchmark outcome"
helix orchestrate status <orchestration-id>
```

The versioned API exposes goal, plan, and orchestration lifecycle routes. M12 MCP adds fourteen typed intelligence tools, three protected intelligence resources, and four reusable prompts through the existing authorization, rate-limiting, audit, and transport boundary. Run the deterministic demonstration and benchmark with:

```bash
pnpm intelligence:demo
pnpm intelligence:benchmark
```

The benchmark uses 100 registered agents and 1,000 measured capability-safe task-unit selections, plus a full orchestration run. It reports measured p50/p95/p99 and average selection latency, throughput, plan validation, completion, replanning, CPU, and heap data. Results are local measurements rather than production capacity guarantees. See [`docs/milestone-12-intelligence.md`](docs/milestone-12-intelligence.md) for architecture, state transitions, security, learning, verification, and limitations.

## M13 autonomous swarm

M13 extends the M12 intelligence layer with a dynamic autonomous swarm control plane. Swarms maintain bounded membership, multiple compatible roles, explicit lifecycle states, coordinator promotion and demotion, capability-safe delegation, task handoffs with loop detection, a collaboration graph, adaptive topology, bounded scale-up and scale-down, health monitoring, deterministic rebalancing, failure recovery evidence, application-level review consensus, result aggregation, and SQLite-backed swarm learning.

The swarm layer does not create a second scheduler or worker pool. Actual delegated work reserves leases through the existing `AgentScheduler`; the existing AgentRegistry, AgentRouter, policy engine, sandbox manager, MCP authorization/audit/rate limiting, and M10 memory ACL/provenance/sanitization rules remain authoritative. Capability mismatch is a hard constraint. High- and critical-risk swarm mutations require explicit `approvedBy` authorization, and all handoffs, fan-out, scaling, and recovery loops are bounded.

Use the new CLI surfaces as follows:

```bash
helix swarm create --goal "Build and review a release pipeline" --topology adaptive --max-agents 12
helix swarm status <swarm-id>
helix swarm members <swarm-id>
helix swarm scale <swarm-id> 6
helix swarm rebalance <swarm-id>
helix swarm graph <swarm-id>
helix swarm explain <swarm-id>
```

The versioned API exposes `/api/v1/swarms` creation and listing together with status, membership, health, graph, critical-path, scale, delegate, handoff, topology, rebalance, explain, and cancellation routes. The MCP adapter adds fourteen dynamic swarm controls to the existing swarm family and two additional lifecycle/topology controls; all remain under the established typed schema, authorization, rate-limit, audit, and redaction boundary. Protected `helix://swarms` and `helix://swarm-collaboration` resources expose governed runtime state.

Run the deterministic demonstration and measured benchmark with:

```bash
pnpm swarm:demo
pnpm swarm:benchmark
```

The M13 benchmark uses 100 registered agents and 1,000 bounded task units and reports measured scaling, formation, delegation, completion, failure/health, rebalancing, consensus, aggregation, memory lookup, throughput, and end-to-end timings. It is a local observation, not a production capacity guarantee. M13 consensus is application-level and not Byzantine fault tolerant; the process-local swarm graph and learning queue require distributed persistence and delivery work for multi-host deployments. See [`docs/milestone-13-autonomous-swarm.md`](docs/milestone-13-autonomous-swarm.md) for the design, operational boundaries, verification, and limitations.

## M14 distributed orchestration and federation

M14 extends the M13 swarm control plane across explicit federation nodes. The federation package provides node registration and lifecycle state, heartbeat and stale-node detection, capability and health-aware routing, signed versioned messages with timestamp/TTL and replay protection, replaceable transports, fencing-token distributed leases, node-aware worker metadata, remote task dispatch and completion evidence, bounded reassignment and recovery, and federated swarm membership and aggregation.

Remote execution is **default-deny** unless the caller supplies explicit `federation:dispatch` authorization and a trusted security context. Authorization, correlation IDs, trace IDs, priority, capabilities, and provenance are preserved across messages. Remote nodes do not inherit local privileges. The existing scheduler, worker path, sandbox, policy engine, memory ACL/provenance/sanitization, and MCP authorization/audit/rate-limiting layers remain authoritative; M14 adds adapters rather than duplicate execution systems.

Use the CLI surfaces as follows:

```bash
helix federation doctor --json
helix federation nodes --json
helix federation node register --name worker-b --endpoint https://worker-b.example --role worker --capabilities coding,testing
helix federation node drain <node-id>
helix federation status --json
helix federation metrics --json
helix federation dispatch task-1 --capabilities coding --local --json
helix federation leases --json
```

The API exposes `/api/v1/federation/nodes`, node status, heartbeat, drain, removal, `/api/v1/federation/status`, `/api/v1/federation/metrics`, `/api/v1/federation/leases`, `/api/v1/federation/tasks/dispatch`, and task status routes. MCP adds governed federation node, dispatch, lease, metrics, message-verification, and trust-inspection actions, together with protected federation resources and recovery/security prompts.

Run the deterministic five-node, 100-agent, 1,000-task demonstration and measured benchmark with:

```bash
pnpm federation:demo
pnpm federation:benchmark
```

M14 benchmark output is measured locally and includes node registration, heartbeat, HMAC verification, capability routing, lease acquire/release, remote dispatch, reassignment, scheduling, and 1,000-task throughput. The in-memory transport is a deterministic test adapter; file/SQLite lease stores are replaceable persistence options but are not distributed consensus. Production deployment still requires shared durable graph/state, a production transport, multi-host lease authority, outbox/idempotency design, TLS and secret management, authorization review, chaos testing, and independent security review. See [`docs/milestone-14-federation.md`](docs/milestone-14-federation.md) for the full design and limitations.

## License

Apache-2.0. Independent implementation. Helix does not copy source code, branding, or proprietary architecture from other projects.
