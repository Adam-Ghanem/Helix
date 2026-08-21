# Milestone 3 — Agent Workers + Execution Runtime

Milestone 3 turns scheduler assignments into executable work. `WorkerPool` creates one `AgentWorker` per registered agent and bridges `AgentScheduler.tick()` to deterministic task execution.

## Flow

`enqueue → scheduler.tick → AgentWorker.run → TaskExecutor → scheduler.complete → AgentRegistry.recordOutcome`

The included `SimulatedExecutor` uses task complexity to produce deterministic latency, quality, and token estimates. No provider or API key is required.

## Example

```bash
pnpm exec tsx examples/aetherflow-workers-demo.ts
```

## Tests

```bash
pnpm exec tsx --test tests/workers-milestone-3.test.ts
pnpm verify
```

Workers support cancellation, AbortController-based timeouts, snapshots, events, pool draining, and many-agent simulation. Future milestones can add real provider executors without changing the worker lifecycle contract.
