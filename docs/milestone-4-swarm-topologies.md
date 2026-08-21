# Milestone 4 — Swarm Topologies

M4 adds a practical swarm layer above AgentRegistry, AgentScheduler, and WorkerPool.

- **Hierarchical:** deterministic coordinator plus capability-selected workers.
- **Mesh:** peer assignments with no permanent coordinator.
- **Adaptive:** switches to mesh when failure rate or parallel queue wait crosses explicit thresholds; otherwise hierarchical is used for sequential work.

Goal decomposition is deterministic: plan, optional implement, optional test, then review. Execution remains owned by the existing scheduler and worker pool.

## Future

True nested sub-swarms, topology-aware scheduler scoring, peer handoff limits, persistent swarm state, and distributed coordination remain TODOs.
