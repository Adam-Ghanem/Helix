# Milestone 10 — Production Memory and Fast Intelligence

## Scope

M10 addresses the primary weakness measured in M9: memory retrieval latency at scale. The milestone adds a real transactional SQLite backend, bounded indexed retrieval, cache support, batched persistence, asynchronous learning writes, duplicate-pattern compaction, efficient maintenance hooks, and a measured M9-style JSONL versus M10 SQLite comparison.

## Architecture

`MemoryBackend` is the stable abstraction consumed by the runtime and learning engine. `MemoryStore` remains available as the M9 JSONL implementation. `SqliteMemoryStore` is the M10 default and uses `better-sqlite3` with WAL mode, `synchronous=NORMAL`, foreign-key enforcement, a busy timeout, and transaction wrappers around batch writes, updates, deletes, tag index updates, and compaction.

The SQLite schema stores typed memory entries in `memory_entries`, legacy records in `legacy_memory_records`, normalized tags in `memory_tags`, and lexical candidates in an FTS5 `memory_fts` table. Indexes cover namespace, agent, swarm, task, type, updated timestamp, confidence, legacy ownership, legacy expiry, and tags. Search applies FTS and SQL filters before hybrid scoring, then enforces the configured retrieval and response limits.

The runtime defaults to `SqliteMemoryStore` under `<dataDirectory>/helix.memory.sqlite`. M9 JSONL remains available through `useSqliteMemory: false`. The optional `migrateJsonlFile` constructor option replays prior M9 upsert/delete and legacy records into SQLite with `INSERT OR IGNORE`, preserving IDs and avoiding duplicate imports. Existing SQLite entries also receive tag and FTS backfill during initialization.

## Cache and learning path

`MemoryCache` is a bounded TTL/LRU cache with prefix invalidation. Entry reads, list reads, and search results use separate key spaces. All SQLite mutations clear or invalidate affected cache entries, and delete/update operations update the normalized tag and FTS indexes in the same transaction.

The runtime queues task outcome learning asynchronously by default. `AsyncLearningQueue` deduplicates replay keys, drains bounded batches, and exposes `flushLearning()` as an explicit durability barrier. `PersistentLearningEngine` uses `createMany` when the backend supports it, so each successful or failed outcome persists its public routing evidence, private agent experience, and solution/failure pattern in one backend transaction. Direct `recordSuccess` and `recordFailure` remain available for deterministic callers and tests.

> Memory remains untrusted data. Learned content is evidence, not executable instruction, and no memory record is allowed to override capability matching or policy authorization.

## Compaction

`SqliteMemoryStore.compact()` can merge duplicate solution, pattern, and routing-hint records by namespace/type/content, preserving the newest winner and recording `mergedSamples`. It can remove expired legacy records and run `VACUUM`. Compaction is explicit rather than hidden in the scheduler because deletion and file-rewrite costs need deployment-specific operational review.

## External surfaces

The API adds authenticated `POST /api/v1/memory/compact` and `POST /api/v1/learning/flush` routes. The CLI adds `helix memory compact [--vacuum] [--expired]` and `helix learning flush`. Memory stats now expose the backend name and cache-entry count through the CLI. Existing memory CRUD/search, learning, MCP, sandbox, provider, and lifecycle surfaces remain compatible.

## Security review

The backend preserves M9 namespace and ACL checks before returning entries. Private agent entries require the correct subject or explicit private-read context. Deletion remains owner/privilege controlled. Provenance is validated before SQLite insertion and again while reading migrated or persisted JSON. Query values are bound parameters; the only dynamically generated SQL fragments are placeholders generated from validated array lengths, and FTS query terms are reduced to a restricted alphanumeric/namespace character set before use.

SQLite files are local durable state and must be protected with operating-system filesystem permissions and deployment-level encryption or disk controls where required. WAL files, backups, and migration inputs are part of the data boundary. The implementation does not claim tamper-evident audit storage or multi-host consensus.

## Benchmark method

The deterministic benchmark uses 100 agents, 1,000 tasks, and 10,000 seeded memories for each backend. It measures routing latency, lookup latency, write latency, p50/p95/p99 values, task completion, routing success, throughput, execution time, CPU user/system time, heap delta, and final memory count. It uses the same deterministic agents, task distribution, provider-free outcome logic, and search queries for both backends.

The recorded local run produced the following results:

| Metric | M9-style JSONL | M10 SQLite | Delta (M10 − M9) |
|---|---:|---:|---:|
| Routing latency average | 16.989621 ms | 11.978535 ms | -5.011087 ms |
| Routing latency p50 | 17.194214 ms | 12.947946 ms | -4.246268 ms |
| Routing latency p95 | 32.290556 ms | 15.028976 ms | -17.261580 ms |
| Routing latency p99 | 34.378289 ms | 16.175717 ms | -18.202572 ms |
| Memory lookup average | 537.045086 ms | 1.073750 ms | -535.971336 ms |
| Memory lookup p50 | 535.519977 ms | 0.296387 ms | -535.223590 ms |
| Memory lookup p95 | 562.317838 ms | 0.311631 ms | -562.006207 ms |
| Memory lookup p99 | 564.074295 ms | 0.341481 ms | -563.732814 ms |
| Memory write average | 3.766714 ms | 14.759598 ms | +10.992885 ms |
| Task completion | 0.909 | 0.909 | 0.000 |
| Routing success | 1.000 | 1.000 | 0.000 |
| Throughput | 20.998389 tasks/s | 37.301916 tasks/s | +16.303527 tasks/s |
| CPU user | 55,129.853 ms | 18,319.473 ms | -36,810.380 ms |
| CPU system | 406.720 ms | 8,429.667 ms | +8,022.947 ms |
| Heap delta | +124.500 MB | +8.482 MB | local process-dependent |
| Final memory count | 13,000 | 13,000 | 0 |

The system-time delta is not presented as an improvement claim: SQLite shifts work into native/system-level database operations, while the JSONL comparison spends substantial user CPU parsing and scoring large in-memory collections. The benchmark is a local deterministic run, not a production capacity guarantee. The task-completion result was unchanged, so M10 does not claim that faster memory retrieval alone improves outcome quality.

## Validation

The M10 suite covers transactional create/restart, batch atomicity, indexes and filters, ACL isolation, cache invalidation and TTL, bounded retrieval, compaction, legacy compatibility, concurrent writes, async queue deduplication, learning batch persistence, runtime SQLite defaults, explicit JSONL compatibility, provenance rejection, and durable file creation. Existing M8/M9 regression suites remain part of the full test command.

The final release gate must still run `pnpm install`, `pnpm typecheck`, `pnpm build`, `pnpm test`, dependency audit, secret scan, and `git diff --check`. Docker integration remains independently optional and must be reported as skipped when no daemon is available.

## Limitations and future work

The current backend is a single-node SQLite design. It is suitable for a production-grade local runtime but not a substitute for a reviewed multi-writer service or distributed vector database. The asynchronous learning queue is in-process and loses pending work if the process terminates before `flushLearning()`; deployments requiring at-least-once delivery need a durable outbox or queue. Embeddings remain deterministic and local. Compaction is explicit. SQLite encryption, online backup orchestration, read replicas, remote vector search, distributed cache coherence, and tamper-evident audit retention remain future work.
