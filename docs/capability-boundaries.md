# Helix capability boundaries

Helix v0.1 is an implemented vertical slice, not a claim that every subsystem in the long-term product specification is complete. The following boundaries are intentional and testable.

| Subsystem | Current behavior | Boundary |
|---|---|---|
| Durable execution | JSONL append-only event store, ordering, idempotency, replay, snapshots, and recovery hooks | A production deployment still needs a reviewed multi-process store such as PostgreSQL or an equivalent event-log service |
| Task orchestration | Validated DAGs, readiness, topological sort, parallel ready branches, critical-path estimation, and safe removal | Dynamic replanning policies beyond bounded graph mutation are not yet implemented |
| Agent runtime | Provider-neutral execution lifecycle, structured decision metadata, health, reputation, routing, and budgets | No private reasoning is stored or exposed; no claim is made that a model provider is connected by default |
| Tools and MCP | Policy-controlled tool request abstraction and audit events | MCP transport, sandbox isolation, and external tool adapters are interfaces to be added; direct unreviewed tool execution is intentionally absent |
| Memory and knowledge | Event evidence is durable and snapshot-capable | Vector search, graph storage, consolidation, and provenance indexing need dedicated backends and are not faked in v0.1 |
| Federation | Lease scheduler models worker ownership and expiry recovery | Remote node authentication, encrypted transport, signatures, and cross-node result synchronization remain unimplemented |
| Dashboard | Read-only live API view for health, agents, event sequence, and executions | Authentication, role-based access, graph visualization, and sensitive-field redaction need production hardening |
| Security | Default-deny rules, approval records, budgets, and explicit high-risk denial | Secret vaults, OS/container sandboxes, formal threat-model verification, and third-party audits remain required before deployment |
| Learning | Structured quality/reliability outcomes and decayed reputation | No unsupported claim of autonomous model training or measurable self-improvement is made |

The correct next step for each boundary is an adapter plus tests, not placeholder methods that return success. Until those adapters exist, Helix reports the boundary in documentation and keeps the default runtime deterministic and local.
