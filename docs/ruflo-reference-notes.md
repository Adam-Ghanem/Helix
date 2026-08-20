# Ruflo public capability reference

Source reviewed: [Ruflo public repository](https://github.com/ruvnet/ruflo?tab=readme-ov-file), accessed 2026-08-20.

The public README presents Ruflo at a high level as an agent meta-harness rather than as an LLM provider. The capability themes relevant to Helix are: a CLI/MCP entry point; routing; swarm coordination; specialized agent catalogs; adaptive or persistent memory; self-learning loops; multiple model providers; hooks; consensus/topology controls; and secure federation across machines.

The public architecture sketch is summarized as `User -> CLI/MCP -> Router -> Swarm -> Agents -> Memory -> Providers`, with a feedback path from memory and learning back into routing and future executions. Ruflo’s README also emphasizes that the harness owns tools, loops, controls, memory, and coordination around a model. These are product-level capability references only.

Helix will remain independent. It will use different naming, domain objects, package structure, persistence contracts, and implementation choices. No Ruflo source code, branding, proprietary implementation details, or private repository information is being copied.

## Translation into Helix requirements

| Public capability theme | Independent Helix interpretation |
|---|---|
| CLI/MCP entry points | Versioned HTTP API plus JSON-capable `helix` CLI; MCP remains a guarded adapter boundary |
| Router | Pluggable scoring strategies combining capability, quality, cost, latency, and availability |
| Swarms | Task-DAG execution with delegation and consensus policies |
| Agent catalog | Replaceable built-in agent profiles with persisted health and reputation |
| Memory and learning | Durable event evidence, structured memory records, and explicit evaluation hooks |
| Hooks and controls | Policy decisions, approval gates, audit events, and resource budgets |
| Federation | Lease/heartbeat interfaces designed for remote workers, not falsely claimed as complete |

The README’s marketing and implementation claims are not treated as verified benchmark evidence. Helix will measure its own behavior and document any unimplemented integration as a capability boundary.

## References

1. [Ruflo repository README](https://github.com/ruvnet/ruflo?tab=readme-ov-file)


The public package manifest additionally shows a large TypeScript/Node ecosystem with a root CLI, selected workspace packages, optional native persistence/vector components, security and federation packages, and explicit build/test/security scripts. Helix will borrow only the general engineering lesson—keep integrations modular and optional—while using a smaller dependency-free core and explicit adapters to avoid pretending that optional provider/database integrations are already complete.

2. [Ruflo public package manifest](https://github.com/ruvnet/ruflo/blob/main/package.json)


## Additional public reference review

The public Ruflo documentation index shows dedicated areas for federation, benchmarks, security, validation, research, reviews, plugins, and iterative improvement cycles. This suggests a mature developer experience treats validation, benchmarks, security, and improvement evidence as first-class repository surfaces rather than afterthoughts.

The public security policy emphasizes supported-version discipline, private vulnerability reporting, reproducible reports, response timelines, and explicit boundary controls such as input validation, parameterized queries, path-traversal prevention, and command-injection protection. Helix will independently add these as engineering requirements where applicable, without copying Ruflo modules or text.

3. [Ruflo public documentation index](https://github.com/ruvnet/ruflo/tree/main/docs)
4. [Ruflo public security policy](https://github.com/ruvnet/ruflo/blob/main/SECURITY.md)
