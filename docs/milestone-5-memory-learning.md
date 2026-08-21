# Milestone 5 — Memory + Learning Loop

Helix now has a small, deterministic local learning loop on top of the existing JSONL `MemoryStore`.

## Flow

```text
AgentScheduler task outcome
        |
        v
   LearningLoop
        |
        v
 MemoryStore (JSONL)
        |
        v
 lexical recall / routing hints
```

## What is implemented

- Successful and failed execution patterns can be persisted.
- Records are namespaced under `helix:patterns`.
- Existing subject/permission filtering is preserved.
- Recall uses the existing deterministic lexical hybrid-style scoring inputs (term match + importance + confidence).
- `LearningLoop.hints()` groups related memories by agent and returns a simple routing signal.
- `attachSchedulerOutcome()` provides a small event bridge for completed/failed scheduler tasks.

## Deliberate limits

This milestone does not add a cloud vector database, embeddings API, or ML model. The local store keeps tests and demos deterministic and offline.

Future work: embeddings, graph edges, pattern consolidation, decay policies, and feeding learned hints into `AgentRouter` as an optional scoring strategy.
