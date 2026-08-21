# Milestone 9 — Intelligence and Persistent Memory

## Scope

Milestone 9 extends Helix from a durable multi-agent execution runtime into a **local-first learning runtime**. The implementation preserves the M8 sandbox boundary and existing memory APIs while adding structured memory entries, namespace-aware ACLs, provenance, deterministic hybrid search, outcome learning, bounded routing signals, and durable agent experience.

The runtime loop is:

> **Task → Memory Recall → Adaptive Routing → Agent Selection → Worker Execution → Outcome → Learning → Memory Persistence → Future Routing Improvements**

No cloud vector database, neural embedding service, or model API key is required for the implementation or tests.

## Architecture

The existing `MemoryStore` remains the compatibility entry point. New memory entries are persisted in the same local JSONL file as append-only `upsert` and `delete` records; the previous `MemoryRecord` API is still supported. Writes are serialized by an in-process promise chain, and a fresh store instance replays the file to restore state.

The `PersistentLearningEngine` creates three related records for a task outcome: a public routing signal, a private agent experience record, and a public solution or failure pattern. The records contain source identifiers and confidence; they do not contain raw credentials, environment secrets, authorization headers, or API keys. Replayed outcomes are rejected by a deterministic outcome key.

The router remains authoritative for capability, health, availability, reputation, and exploration. Learning contributes only an optional bounded signal. The adaptive strategy clamps that signal to **±0.10**, and capability filtering happens before scoring whenever at least one fully compatible candidate exists. Consequently, historical memory cannot make a capability mismatch eligible.

## Memory model

Each `MemoryEntry` has an identifier, typed namespace, memory type, content, primitive metadata, timestamps, source, optional agent/swarm/task/session identifiers, confidence, tags, provenance, and an access policy. Supported types include `fact`, `task`, `solution`, `pattern`, `failure`, `decision`, `observation`, `agent-experience`, `workflow`, and `routing-hint`.

Namespaces are constrained to `global`, `agent:<agentId>`, `swarm:<swarmId>`, `task:<taskId>`, and `session:<sessionId>`. A request may read global public evidence, its own private namespace, authorized swarm/task namespaces, or explicitly public entries. Private agent memory is not exposed to arbitrary agents.

## Provenance and trust

Every new memory entry requires a provenance object with `sourceType`, `sourceId`, timestamp, and confidence. Task learning uses `sourceType: task-outcome` and records the task, execution, agent, and optional swarm identifiers. Memory is **untrusted data**: its text is searchable and explainable, but it is never parsed as executable code or treated as an instruction to bypass policy.

The sanitization layer recursively redacts secret-like keys and credential-like values, bounds collection depth and string length, and categorizes failures without copying sensitive error material. Sandbox results are sanitized before being stored as observations.

## Hybrid search

Search combines configurable keyword, deterministic semantic, recency, namespace, confidence, and provenance components. The default weights are 30%, 40%, 10%, 10%, 5%, and 5%. Each result exposes `matchedBy` and an explanation string containing the component values, so routing decisions remain inspectable.

`DeterministicEmbeddingProvider` is a stable hashing-based vectorization abstraction for tests and local operation. It is explicitly **not a production neural semantic model**. The `EmbeddingProvider` interface allows future OpenAI-compatible, local-model, or other providers without changing `MemoryStore`.

Memory decay is configurable through a half-life in days. Decay changes ranking influence and does not delete records. Automatic deletion is not enabled.

## Learning loop

Successful outcomes create solution patterns, routing hints, agent experience, task characteristics, capability tags, execution metadata, and a sanitized output summary. Failed outcomes create failure patterns with an error category, retry/attempt metadata, agent and capability tags, and provenance. The learning engine exposes `recordSuccess`, `recordFailure`, `recall`, `suggestRouting`, `suggestExecutionHints`, `getAgentExperience`, and bounded routing score methods.

A repeated-failure signal requires at least three failures and a configurable confidence threshold before an agent appears in `avoidAgents`. Signals decay by half-life and remain temporary evidence rather than permanent blacklists. A single failed task cannot permanently poison routing.

## Interfaces for future backends

The local JSONL implementation is the default. The search and embedding contracts are deliberately separated from storage so future versions can add SQLite, PostgreSQL/pgvector, Qdrant, Chroma, Neo4j, or other graph/vector adapters without rewriting the public `MemoryStore` API. The existing local `KnowledgeGraph` remains available for simple provenance-aware relationships.

## API and CLI

The API now supports memory search, create, get, and delete under `/api/v1/memory`, plus learning hints, agent experience, and outcome ingestion under `/api/v1/learning`. Legacy memory creation and search remain available.

The CLI adds:

```text
helix memory search "authentication TypeScript"
helix memory list
helix memory inspect <id>
helix memory stats
helix learning agent <agentId>
helix learning hints "authentication debugging"
```

The MCP package exposes governed tools named `helix.memory.search`, `helix.memory.get`, `helix.memory.list`, `helix.memory.stats`, `helix.learning.recall`, `helix.learning.routingHints`, and `helix.learning.agentExperience`. Each tool has an explicit schema and `memory:read` permission.

## Simulation and benchmark

`examples/helix-memory-learning-demo.ts` runs 100 agents and 1,000 deterministic tasks, then reports initial routing, learned routing, success rate, memory count, useful patterns, improved agents, repeated-failure agents, and routing changes. It performs no real LLM calls.

`benchmarks/memory-learning.ts` measures baseline router versus router plus learning. It reports measured routing success, completion, wait, execution, stability, lookup latency, and memory count. Documentation must contain only numbers produced by actually running the benchmark; no benchmark values are hard-coded here.

## Security review

| Risk | Control | Residual limitation |
|---|---|---|
| Secret persistence | Recursive key/value sanitization; no raw environment storage | New secret formats require continued review |
| Cross-agent leakage | Namespace checks, visibility, owner, subject, swarm membership, and private agent namespaces | Deployment identity mapping remains application responsibility |
| Namespace bypass | Strict namespace parser and ACL gate on list/get/search | `canReadPrivate` is an explicitly privileged capability |
| Malicious memory influence | Memory is untrusted data; explanations are evidence, not executable instructions | Consumers must not execute memory text |
| Unbounded learning | Router clamps learning to ±10%; capability filtering precedes scoring | Weight tuning still requires evaluation |
| Single-outcome poisoning | Idempotency key, confidence, repeated-failure threshold, and decay | Coordinated poisoning is a future evaluation concern |
| Replay and duplicates | Deterministic outcome key prevents repeated learning events | Cross-process locking is not yet distributed |
| Corrupted JSONL | Restart parser fails closed on malformed non-ENOENT input | Production deployments should use checksums or SQLite transactions |
| Unauthorized deletion | Owner or explicit delete capability required | API policy must map authenticated identities correctly |

M8 sandbox controls are unchanged. Local execution remains best-effort process control, while Docker provides the stronger isolation path when a Docker daemon and reviewed image policy are available.

## Limitations

The deterministic embedding provider is not a trained semantic model. The local JSONL store is suitable for deterministic local operation and tests but is not a substitute for a transactional multi-process database at production scale. The current runtime derives a compact task type and analysis capability from the planner task title; richer task classification can be added later. Learning is deterministic statistical evidence, not model training. A production deployment still needs authenticated identity propagation, a reviewed persistence backend, secret-manager integration, image provenance, and adversarial evaluation of memory poisoning and prompt injection.
