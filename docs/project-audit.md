# Helix project audit and superiority targets

## Executive assessment

Helix currently has a credible, tested orchestration core with both a deterministic local provider and an OpenAI-compatible HTTP adapter. It is not yet “better than Ruflo” across the whole product surface. Its strongest present advantages are explicit capability boundaries, deterministic tests, policy-first tool handling, cross-instance event and lease durability, signed federation primitives, plugin trust gates, provider-neutral execution, and a clean TypeScript foundation. Its largest remaining gaps are OS-level sandboxing, complete MCP transport, durable cross-node result synchronization, and a richer dashboard and developer workflow.

The audit uses Ruflo’s public repository README, package manifest, documentation index, and security policy as high-level product references only. The comparison is capability-oriented and does not copy source code, branding, or proprietary implementation details.[1] [2] [3] [4]

## Current implementation scorecard

| Area | Current evidence in Helix | Assessment | Superiority target |
|---|---|---|---|
| Durable execution | Ordered JSONL events, idempotency, snapshots, retries, lifecycle controls, restart rehydration, cross-instance append locking, and persisted lease state | Strong local foundation; not yet a distributed store | Add crash-injection tests, schema migrations, and a production multi-process adapter |
| Orchestration | Validated DAGs, parallel ready branches, routing, budgets, workflow engine, swarm topologies | Broad primitives; runtime default plan is still intentionally small | Run user-defined workflows and dynamic replanning with durable state and bounded failure semantics |
| Intelligence quality | Evaluation contracts, consensus, reputation, trajectory patterns, provider registry, and OpenAI-compatible adapter | Real provider path now exists; quality is still not independently benchmarked | Compare strategies and providers with reproducible quality, cost, latency, and reliability evidence |
| Memory and knowledge | ACL memory, provenance, lexical search, knowledge entities/relations | Safe structured baseline; no vector/graph query backend | Hybrid lexical/vector/graph retrieval with retention, provenance, and evaluation-backed recall metrics |
| Tools and MCP | Schema registry, risk levels, policy decision boundary, manifest import | Safe declaration layer; transports and isolation incomplete | Signed plugins, reviewed MCP transports, sandboxed handlers, and end-to-end policy/audit tests |
| Security | Default deny, bearer API auth, request bounds, rate limits, path validator, allowlisted executor, plugin trust gate | Better than a permissive demo; not a deployment security certification | Threat-model tests, secret management, OS/container sandbox, RBAC, signed releases, and secure defaults in every deployment mode |
| Federation | Signed TTL messages, replay protection, node registry, heartbeat, lease recovery | Secure protocol foundation; no network/result plane | Authenticated, encrypted, durable multi-node execution with fault injection and result reconciliation |
| Developer experience | CLI, SDK, API, golden demo, benchmark, CI, roadmap and boundaries docs | Good repository-level baseline | Generated contracts, plugin SDK, project scaffolding, release artifacts, shell completion, and operational runbooks |

## Highest-impact remediation order

The review completed the first reliability, security, and provider tranche: cross-instance event locking, atomic event snapshots, persisted scheduler leases, signed federation messages with replay protection, plugin trust gates, traversal-safe command execution, malformed-input hardening, and an OpenAI-compatible provider adapter with API/CLI wiring. The next tranche is to implement an actual OS/container sandbox and reviewed MCP transport, make federation results durable, evaluate real providers with reproducible quality/cost/latency contracts, and improve the dashboard and developer workflow.

## Non-negotiable honesty rules

Helix must not report model quality, benchmark throughput, distributed reliability, sandbox isolation, or federation security unless the corresponding behavior is executed and measured. The deterministic provider benchmark is useful for control-plane latency only; it is not a model-quality benchmark or a production capacity guarantee.

## References

1. [Ruflo public repository README](https://github.com/ruvnet/ruflo?tab=readme-ov-file)
2. [Ruflo public package manifest](https://github.com/ruvnet/ruflo/blob/main/package.json)
3. [Ruflo public documentation index](https://github.com/ruvnet/ruflo/tree/main/docs)
4. [Ruflo public security policy](https://github.com/ruvnet/ruflo/blob/main/SECURITY.md)
