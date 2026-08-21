# Helix verification record

This record reports commands actually run in the local workspace. It does not claim unperformed distributed, provider, or production-security validation.

| Check | Result | Evidence |
|---|---|---|
| Typecheck | Pass | `pnpm exec tsc -p tsconfig.json --noEmit` |
| Build | Pass | `pnpm exec tsc -p tsconfig.json` |
| Unit/integration tests | Pass, 47 tests | Core runtime, recovery, legacy memory, M9 memory CRUD/ACL/provenance/search/decay/persistence/concurrency/scale/sanitization, tools/MCP, workflows, consensus, telemetry, swarm, knowledge graph, evaluation, learning, security, federation, providers, plugins, durable leases, HTTP provider adapter, model discovery, routing evidence, RBAC, plugin policy isolation, local sandbox policy, lifecycle, cleanup, concurrency, audit redaction, Docker policy, runtime sandbox integration, and sandbox failure cleanup |
| CLI smoke test | Pass | Compiled `helix run ... --json`, lifecycle controls, `helix recover --json`, and M8 sandbox command surface compile and execute; Docker availability is reported by `helix sandbox doctor` |
| API smoke test | Pass | Public health, unauthorized rejection, authenticated execution creation, checkpointing, legacy and typed memory write/search/get/delete, learning hints/experience/outcome, telemetry endpoints, local provider-wiring path, sandbox list/status/destroy routes, and MCP registration surface are covered by the versioned API/runtime implementation |
| Dependency audit | Pass | `pnpm audit --audit-level high` reported no known vulnerabilities |
| Secret scan | Pass | Source-level scan found no private-key or common API-key patterns |
| Measured benchmark | Pass | 10 deterministic executions with durable lease persistence and sandbox-manager initialization: average 32.40 ms, min 18.54 ms, max 46.01 ms, 30.86 executions/s, 4 tasks and 19 events per execution |
| M8 sandbox demo | Pass | Local sandbox demo executes a real command through `SandboxManager`, prints resource/limitation metadata, and records secret-safe audit data; Docker unit policy tests pass without requiring a daemon |
| M9 memory-learning demo | Pass | `pnpm memory-demo` ran 100 agents and 1,000 deterministic tasks with no LLM calls, producing 3,000 memory entries and reporting initial/learned routing, success rate, useful patterns, improved agents, repeated-failure agents, and routing changes |
| M9 benchmark | Pass | `pnpm memory-benchmark` measured baseline versus learning over 100 agents and 1,000 tasks: baseline routing success 1.000, completion 0.910, wait 0.077454 ms, execution 0.002648 ms, stability 0.333333; learning routing success 1.000, completion 0.910, wait 15.978893 ms, execution 0.003645 ms, stability 0.333333, memory lookup 101.088450 ms, 3,000 memories |

The local deterministic provider reports zero tokens and zero cost because it performs no external model call. Benchmark figures are local measurements from the deterministic provider on this development machine, not production capacity guarantees. The M9 benchmark intentionally reports the measured lookup and routing overhead; it does not claim that learning improves the current synthetic task-completion distribution. The newer result includes synchronous atomic lease-state persistence; the latency increase is a deliberate durability tradeoff, not a model-performance claim. The API binds to loopback by default; when `HELIX_API_KEY` is configured, all non-health routes require bearer authentication, and request bodies plus per-client request rates are bounded.

## Release gates still required

A production release still needs authenticated API deployment, TLS termination, secret-manager integration, Docker daemon/image provenance review, seccomp/AppArmor policy review, signed images, sandbox chaos tests, MCP isolation tests, federation authentication tests, chaos tests against real worker processes, OpenTelemetry exporters, database migrations, and human review of policy definitions. Docker integration was explicitly skipped in this environment because no Docker daemon is available; Docker policy generation and availability detection were tested instead. These are explicit capability boundaries in [`capability-boundaries.md`](capability-boundaries.md), not hidden stubs.
