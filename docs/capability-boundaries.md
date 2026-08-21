# Helix capability boundaries

Helix v0.1 is an implemented vertical slice, not a claim that every subsystem in the long-term product specification is complete. The following boundaries are intentional and testable.

| Subsystem | Current behavior | Boundary |
|---|---|---|
| Durable execution | JSONL append-only event store with cross-instance append locking, ordering, idempotency, replay, atomic snapshots, pause/resume/cancel/retry/checkpoint controls, restart rehydration, and persisted scheduler leases | A production deployment still needs crash-injection tests, schema migrations, and a reviewed multi-process store such as PostgreSQL or an equivalent event-log service |
| Task orchestration | Validated DAGs, readiness, topological sort, parallel ready branches, critical-path estimation, and safe removal | Dynamic replanning policies beyond bounded graph mutation are not yet implemented |
| Agent runtime | Provider-neutral execution lifecycle, structured decision metadata, health, reputation, routing, budgets, deterministic local provider, and OpenAI-compatible HTTP provider with timeout and usage accounting | Provider quality is not benchmarked by default; no private reasoning is stored or exposed |
| Tools and MCP | Schema validation, risk classification, handler-gated policy boundary, MCP manifest import, and audit events | Reviewed MCP transports and external tool adapters remain deployment-specific; direct unreviewed tool execution is intentionally absent |
| Memory and knowledge | Access-controlled structured memory, deterministic search, provenance, graph entities, versioning, and relations | Vector search, graph query indexes, consolidation jobs, and retention policies need dedicated production backends |
| Federation | Lease scheduler plus registered nodes, heartbeats, HMAC-signed messages, TTLs, and replay protection | Key distribution, encrypted transport, cross-node result synchronization, and durable federation state remain unimplemented |
| Dashboard | Read-only live API view for health, agents, event sequence, and executions | Authentication, role-based access, graph visualization, and sensitive-field redaction need production hardening |
| Security and sandbox | Default-deny rules, RBAC, secret metadata, request bounds, rate limits, canonical path and symlink-aware checks, executable allowlists, environment filtering, local process-group termination, Docker read-only/non-root/capability-drop/resource/network controls, plugin signature gates, and secret-safe sandbox audit logs | Secret-manager integration, Docker daemon/image provenance, seccomp/AppArmor review, signed images, OS/container deployment hardening, formal threat-model verification, and third-party audits remain required before deployment |
| Learning | Structured quality/reliability outcomes, decayed reputation, trajectory patterns, provider discovery, and evaluator contracts | No unsupported claim of autonomous model training or measurable self-improvement is made; learned patterns are in-process until a durable learning backend is added |

The correct next step for each remaining boundary is an adapter plus tests, not placeholder methods that return success. M8 now has a real local process backend and a Docker backend; Helix still reports the limits of each backend explicitly and keeps the default runtime deterministic and local.
