# Helix capability parity roadmap

Helix is targeting the same broad class of autonomous orchestration capability as Ruflo while remaining an independent implementation. “Parity” here means comparable user-facing capability areas and operational guarantees, not source-level or architectural duplication.

| Capability area | Helix current state | Next engineering step |
|---|---|---|
| CLI and SDK | Run, lifecycle, approvals, memory, telemetry, JSON output, TypeScript client | Add project initialization, plugin discovery, shell completion, and versioned SDK packages |
| Durable execution | Ordered idempotent event log, replay, snapshots, lifecycle, retry, recovery | Add multi-process storage adapter, leases persisted across daemon restarts, and migration compatibility |
| Routing and agents | Catalog, health, reputation, adaptive scoring, configurable strategies | Add provider/model capability discovery, explicit exploration policies, and persistent route evidence |
| Swarms and consensus | Topology planner, assignment coordinator, majority/weighted/confidence consensus, workflows | Add debate rounds, supervisor policies, dynamic replanning, and durable swarm state |
| Memory and knowledge | Access-controlled structured memory, provenance, search, graph entities and relations | Add embedding/vector adapter, graph query indexes, consolidation jobs, and retention policies |
| Tools and MCP | Schema validation, risk classification, policy boundary, MCP manifest import | Add reviewed transports, sandbox backends, plugin permission manifests, and end-to-end isolation tests |
| Security and approvals | Default deny, high-risk denial, approval records, API bearer auth, request bounds, rate limits | Add secret vaults, RBAC, signed plugins, path validators, safe command execution, and security release gates |
| Observability | Correlated spans, metrics, logs, runtime telemetry endpoint | Add OpenTelemetry exporters, persistent metric aggregation, and dashboard drill-downs |
| Learning and evaluation | Quality/reliability outcomes and decayed reputation | Add trajectory evaluators, rule/schema/test judges, human review, and measurable strategy comparisons |
| Federation | Lease scheduler and recovery model | Add authenticated nodes, signed messages, encrypted transport, heartbeat persistence, and result synchronization |
| Developer experience | Dashboard shell, examples, measured benchmark, documentation, CI | Add generated API schemas, release manifests, migration guides, package publishing, and plugin SDK |

The roadmap intentionally separates what is **implemented and measured** from what is **planned**. Helix will not claim complete parity until each row’s next step has code, tests, and operational evidence.

## Reference basis

The capability areas are informed by public product and repository documentation from Ruflo, including its public README, package manifest, documentation index, and security policy. Helix uses these sources as high-level product references only and does not copy their source code, branding, or proprietary implementation details.

## References

1. [Ruflo public repository README](https://github.com/ruvnet/ruflo?tab=readme-ov-file)
2. [Ruflo public package manifest](https://github.com/ruvnet/ruflo/blob/main/package.json)
3. [Ruflo public documentation index](https://github.com/ruvnet/ruflo/tree/main/docs)
4. [Ruflo public security policy](https://github.com/ruvnet/ruflo/blob/main/SECURITY.md)
