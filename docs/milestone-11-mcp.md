# Milestone 11 — Full MCP Ecosystem

## Scope

M11 turns Helix into a controlled MCP-enabled orchestration platform without duplicating the runtime, scheduler, workers, memory, sandbox, swarm, provider, or policy implementations. The MCP layer is an adapter over existing Helix capabilities. It uses the official `@modelcontextprotocol/sdk` v1.30.0 server APIs for tools, resources, prompts, stdio, and Streamable HTTP [1] [2].

> MCP tools are an interface to Helix capabilities, not an alternate execution authority. High-risk operations still pass through Helix authorization and existing sandbox/policy controls.

## Tool registry

`McpToolRegistry` is a typed registry with `register`, `registerMany`, `get`, `list`, `has`, `count`, `listByFamily`, and `execute`. Each definition contains a unique name, description, Zod input schema, family, risk classification, permissions, and a handler. Duplicate names fail deterministically with `CONFLICT`.

The M11 server registers **176 unique tools** across 20 coherent families. These are not aliases: each handler dispatches into a real Helix runtime, memory, scheduler, policy, sandbox, workflow, evaluation, telemetry, or provider boundary. GitHub and browser families truthfully report an unconfigured connector boundary rather than performing fake network operations.

| Family | Count | Examples of delegated behavior |
|---|---:|---|
| Agents | 12 | AgentRegistry list, status, registration, status transitions, capability and reputation inspection |
| Tasks | 12 | Runtime execution creation, event-backed task listing and inspection, execution cancel/retry |
| Scheduler | 8 | Lease listing, heartbeat, release, recovery, queue and assignment views |
| Workers | 8 | Agent-backed worker pool status, cancellation, snapshots, drain views |
| Swarm | 12 | Deterministic topology, members, health, submit, decompose, rebalance boundary |
| Memory | 16 | SQLite/JSONL CRUD, ACL, namespace, search, stats, compaction, cache and provenance views |
| Learning | 8 | Persistent success/failure, recall, routing hints, experience, queue flush and stats |
| Sandbox | 10 | Doctor, status, audit, policy, path/command validation, capabilities, governed execution |
| Security | 8 | Status, audit/event views, metadata-only secret posture, role and redaction views |
| Policy | 8 | Rule listing, explain/check boundary, approvals and explicit reload boundary |
| Providers | 8 | Provider identity, model registry views, health, metrics, selection boundary |
| Models | 6 | Model list/info/capabilities/health/pricing/latency views |
| Workflows | 10 | Validate, compile, create, list, deterministic run, status/history/resume boundary |
| Evaluation | 8 | Register schema evaluators, run/results/report/metrics boundaries |
| Federation | 8 | Node/queue/audit/trust views with remote send denied by default |
| System | 8 | Health, version, config boundary, telemetry metrics, events, diagnostics and doctor |
| GitHub | 8 | Explicit unconfigured connector boundary; no implicit remote calls |
| Filesystem | 8 | Workspace, roots, metadata, validation and policy boundary views |
| Browser | 5 | Explicit unconfigured connector status/capability boundary |
| Events | 5 | Event list/history/type/recent and event metrics |

The registry applies per-actor, per-family, and per-tool rate limits. Defaults are 240 read operations, 60 writes, 20 executions, 10 administrative operations, and 5 remote operations per minute per bucket. Sensitive operations therefore have substantially lower defaults than read-only discovery.

## Authorization and audit

Every call receives an actor, request ID, risk classification, and family. The default `mcp-user` actor is a viewer. Viewer calls may read authorized public data but cannot spawn agents, write memory, execute sandbox commands, approve policy, or send federation messages. Operators can perform ordinary writes and tool requests; administrators are required for administrative boundaries. Memory ACL and namespace checks run inside the existing M10 `SqliteMemoryStore` path and are never bypassed by MCP.

Every invocation produces an in-memory structured audit record containing timestamp, request ID, actor, tool, family, risk, sanitized argument metadata, authorization result, execution result, duration, and typed error category. Sanitization removes credential-shaped values, authorization headers, tokens, passwords, and private-key-like material. Audit retention is bounded to 10,000 records in this local implementation.

Errors are normalized into `INVALID_INPUT`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `CONFLICT`, `TIMEOUT`, `DEPENDENCY_FAILURE`, or `INTERNAL_ERROR`. The adapter does not return stack traces, secrets, or raw filesystem paths to MCP callers.

## Official MCP surfaces

The server registers eight protected resources:

```text
helix://agents
helix://tasks
helix://scheduler
helix://swarm
helix://memory
helix://metrics
helix://events
helix://system
```

It also registers six reusable prompts: `helix_plan_task`, `helix_review_result`, `helix_debug_task`, `helix_security_review`, `helix_swarm_plan`, and `helix_memory_recall`. Prompts explicitly instruct consumers to respect policy and treat memory as untrusted evidence.

The official SDK provides both supported transports required by M11:

```text
helix mcp serve                 # stdio
pnpm mcp:serve:http             # Streamable HTTP on 127.0.0.1:8790/mcp
```

The CLI supports discovery and diagnostics:

```text
helix mcp doctor --json
helix mcp tools --json
helix mcp resources --json
helix mcp prompts --json
```

For Claude Code, a local stdio registration can use the built project command:

```bash
claude mcp add helix -- pnpm --dir /path/to/Helix mcp:serve
```

For HTTP clients, configure the MCP endpoint as `http://127.0.0.1:8790/mcp` after starting `pnpm mcp:serve:http`. The HTTP launcher binds to loopback by default. Authentication, TLS termination, and deployment-level host validation remain outside this local launcher and must be added before exposing it remotely.

## Demonstration

`examples/helix-mcp-demo.ts` performs the requested deterministic flow: it starts an in-process M11 server, discovers tools, lists agents, creates a runtime task, runs a scheduler tick, inspects assignments, checks worker status, queries memory, reads metrics, and prints recent audit evidence. It uses no API keys or external services.

## Benchmark

The benchmark uses 176 tools, 100 registered agents, and 1,000 deterministic task-unit calls. It measures actual registry initialization, 50 discovery calls, 1,000 authorized system-health tool calls, isolated authorization checks, throughput, heap delta, and audit count.

| Metric | Measured local result |
|---|---:|
| Tool count | 176 |
| Agents | 100 |
| Task units | 1,000 |
| Registry initialization | 18.116183 ms |
| Discovery average / p50 / p95 / p99 | 0.039901 / 0.035706 / 0.081035 / 0.099152 ms |
| Authorized execution average / p50 / p95 / p99 | 0.041672 / 0.031555 / 0.044147 / 0.096504 ms |
| Authorization-only average | 0.000409 ms |
| Throughput | 23,695.283 calls/s |
| Heap delta | +11.242 MB |
| Audit events | 1,000 |
| External calls | 0 |

These figures are a local deterministic measurement on the development machine, not a production capacity promise. The task units are MCP tool calls, not 1,000 full multi-agent runtime executions. No real LLM, GitHub, browser, federation, or external API calls were made.

## Limitations

The M11 registry is in-process and its audit log and rate limiter are local-memory components. A distributed deployment needs shared rate-limit state, durable audit storage, actor identity propagation, TLS, host validation, and deployment-level authentication. GitHub and browser connectors are intentionally boundary-only until explicit connectors are configured. Federation send remains denied by default. The official SDK transport adapter is implemented and exercised locally, but CI and a remote MCP client matrix were not run.

## References

[1]: https://github.com/modelcontextprotocol/typescript-sdk "Official MCP TypeScript SDK repository"

[2]: https://ts.sdk.modelcontextprotocol.io/ "Official MCP TypeScript SDK v1 documentation"
