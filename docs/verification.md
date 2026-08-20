# Helix verification record

This record reports commands actually run in the local workspace. It does not claim unperformed distributed, provider, or production-security validation.

| Check | Result | Evidence |
|---|---|---|
| Typecheck | Pass | `pnpm exec tsc -p tsconfig.json --noEmit` |
| Build | Pass | `pnpm exec tsc -p tsconfig.json` |
| Unit/integration tests | Pass, 14 tests | Durable events, DAG validation, policy, routing, runtime execution, recovery, memory, tools/MCP, workflows, consensus, telemetry, swarm, knowledge graph, evaluation, and learning |
| CLI smoke test | Pass | Compiled `helix run ... --json`, `helix execution <id> checkpoint`, and `helix recover --json` completed successfully |
| API smoke test | Pass | Public health, unauthorized rejection, authenticated execution creation, checkpointing, memory write/search, and telemetry endpoints returned expected responses |
| Dependency audit | Pass | `pnpm audit --audit-level high` reported no known vulnerabilities |
| Secret scan | Pass | Source-level scan found no private-key or common API-key patterns |
| Measured benchmark | Pass | 10 deterministic executions: average 5.70 ms, min 3.20 ms, max 20.99 ms, 175.34 executions/s, 4 tasks and 19 events per execution |
| Golden demo | Pass | Completed a 4-task, 19-event repository-analysis orchestration flow with the deterministic local provider |

The local deterministic provider reports zero tokens and zero cost because it performs no external model call. Benchmark figures are local measurements from the deterministic provider on this development machine, not production capacity guarantees. The API binds to loopback by default; when `HELIX_API_KEY` is configured, all non-health routes require bearer authentication, and request bodies plus per-client request rates are bounded.

## Release gates still required

A production release still needs authenticated API deployment, a reviewed multi-process event store, TLS termination, secret-manager integration, sandbox implementation, MCP isolation tests, federation authentication tests, chaos tests against real worker processes, OpenTelemetry exporters, database migrations, and human review of policy definitions. These are explicit capability boundaries in [`capability-boundaries.md`](capability-boundaries.md), not hidden stubs.
