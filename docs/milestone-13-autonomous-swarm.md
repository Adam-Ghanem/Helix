# M13 — Autonomous Swarm

M13 extends Helix with a deterministic, bounded autonomous swarm layer. A swarm is a dynamic team attached to a goal. It maintains members, roles, topology, state, strategy, health, collaboration evidence, and bounded operational limits while delegating actual work to the existing Helix scheduler and workers.

## Scope and invariants

M13 does not replace the M12 orchestrator, scheduler, worker pool, AgentRegistry, AgentRouter, memory backend, sandbox manager, policy engine, or MCP governance. The swarm layer is a control-plane coordinator. It selects and changes team composition, records decisions, and asks the existing scheduler to reserve real work. It never creates a second scheduler or bypasses policy and sandbox controls.

The central safety invariant is capability-first selection:

> A reputation score, health score, historical hint, or learning bonus can rank eligible agents, but it can never compensate for a missing required capability.

All swarm fan-out, handoff, retry, scale, and recovery paths are bounded. Formation is limited to `maxAgents * 16` task units, scale operations respect `minAgents` and `maxAgents`, handoffs are limited by `maxHandoffs`, and scheduler leases remain the authoritative capacity reservation. High- and critical-risk swarms require an explicit `approvedBy` authorization before formation or mutation.

## Domain model

`Swarm` contains an identifier, name, goal identifier, topology, optional coordinator, member list, lifecycle state, routing strategy, risk, bounds, and timestamps. Members retain a snapshot of capabilities and health together with status, roles, current tasks, reputation, contribution, and activity timestamps. A member may hold multiple compatible roles from the M13 role set: `COORDINATOR`, `PLANNER`, `RESEARCHER`, `IMPLEMENTER`, `TESTER`, `REVIEWER`, `SECURITY`, `PERFORMANCE`, `MEMORY`, and `OBSERVER`.

The lifecycle is explicit: `CREATED → FORMING → READY → RUNNING → REBALANCING → COMPLETING → COMPLETED`, with bounded transitions to `PAUSED`, `FAILED`, or `CANCELLED`. Terminal states cannot be restarted. Each transition emits a durable event through the runtime event store.

## Formation and coordination

`DynamicSwarmManager.form()` stores task and dependency nodes, selects a topology, and assigns tasks in stable dependency-and-identifier order. If a capability has no current member, it provisions the best eligible registry agent within the swarm limit. Routing then considers availability, current load, health, reputation, specialization, and the existing router strategy. Formation does not reserve worker leases; it describes a plan. Actual delegation reserves an `AgentScheduler` lease.

The coordinator abstraction is deterministic. It prefers agents with planning capability, then higher reputation, then stable agent identifier order. It can be promoted or demoted explicitly. Coordinator replacement is performed through member operations and remains subject to health, risk, and capacity rules.

## Delegation and handoff

Delegation supports direct agent, role, capability, and swarm targets. Every concrete delegation is capability-checked and, when it represents actual work, passes through `LeaseScheduler.acquire()`. Completion releases that lease and updates member activity and contribution.

Handoffs preserve a reason, sequence, source, destination, and task identifier. A bounded handoff history rejects self-handoffs, reverse edges, repeated receivers, and attempts beyond `maxHandoffs`. This prevents cycles such as `A → B → A → B` from becoming an unbounded autonomous loop.

## Collaboration graph

The graph is an in-memory abstraction with durable event evidence. Agent and task nodes are connected by delegation, handoff, dependency, and rebalancing edges. The API exposes neighbors, collaboration history, task flow, and a deterministic dependency critical path. A graph database is not required.

## Adaptive topology

M13 supports `hierarchical`, `mesh`, `adaptive`, `pipeline`, `parallel`, `consensus`, and `hybrid` topologies. The rules are explicit and explainable:

| Signal | Decision tendency |
|---|---|
| High parallelism | `parallel` or `mesh` |
| High dependency density | `pipeline` |
| High failure or high risk | `hierarchical`, with coordinator and security review |
| Low load | collapse unnecessary roles and scale down idle members |
| Mixed signals | `hybrid` or retain the explicit operator choice |

Topology changes emit `swarm.topology.changed` and store a bounded learning observation. The system reports the rule and inputs rather than pretending that a model produced an opaque decision.

## Scaling, health, and rebalancing

Scale-up selects eligible, non-member registry agents until the requested count or swarm maximum is reached. Scale-down removes only idle, non-coordinator members and cannot cross `minAgents`. Registry capacity is a hard upper bound.

`SwarmHealthMonitor` observes agent health, overloaded members, active tasks, failures, timeouts, queue leases, utilization, handoffs, and stalls. It emits `swarm.agent.unhealthy`, `swarm.agent.overloaded`, and `swarm.task.stalled` evidence. Rebalancing identifies an overloaded source, finds an idle compatible target, releases the old lease, acquires a new lease, updates task ownership, and records the move. It reuses scheduler capacity logic and does not duplicate `LoadManager`.

## Failure recovery

The M13 recovery sequence is deterministic and bounded: classify the failure, decide whether retry, handoff, replacement, or replan is appropriate, select a capability-safe alternative, execute through the existing scheduler and worker path, evaluate the evidence, and persist learning. Sandbox and policy denials remain denials; M13 cannot override them. An unavailable registry or scheduler capacity produces an explicit failure instead of fabricated completion.

## Consensus and result aggregation

Review consensus filters out offline, unhealthy, and capability-mismatched voters before invoking the existing application-level consensus package. Majority, unanimous, and weighted strategies are supported. Weighted votes use health and success quality only after capability eligibility has been established. The result reports eligible votes, excluded votes, support-derived confidence, dissent, and a limitation statement.

This is not Byzantine fault tolerance. It is an application-level review mechanism for trusted or semi-trusted Helix agents.

`SwarmResultAggregator` behavior is represented by `DynamicSwarmManager.aggregate()`. It combines only supplied task results, agent identifiers, review outcomes, warnings, and scores. Missing outputs are not invented. When scores exist, it reports their measured average; otherwise it reports the supplied completion ratio.

## Memory and learning

M13 stores team composition, handoff, topology, and rebalancing observations in the M10 backend under `swarm:<id>`. Entries include provenance, swarm identity, source, confidence, tags, and access policy. Reads use the swarm namespace and access context. Existing ACL, namespace, provenance, sanitization, SQLite WAL, FTS5, and compaction behavior remains authoritative.

Learning is advisory only. It can influence ranking among eligible agents but cannot bypass capabilities, authorization, risk approval, scheduler capacity, or sandbox policy.

## External surfaces

The runtime exposes the swarm manager through `HelixRuntime.swarms` and M12 `HelixOrchestrator` wrappers. The CLI provides `helix swarm create`, `status`, `members`, `scale`, `rebalance`, `delegate`, `handoff`, `graph`, and `explain`. The API provides versioned `/api/v1/swarms` endpoints for lifecycle, membership, scaling, delegation, handoffs, topology, health, graph, rebalancing, and explainability.

The MCP adapter adds dynamic swarm operations to the existing `swarm` family. They retain the M11 authorization, audit, rate-limit, input-schema, redaction, and error-classification path. Read operations use READ risk; team mutation is WRITE risk. Protected swarm and collaboration resources expose runtime state only after resource authorization.

## Verification

The M13 branch includes 24 deterministic tests covering dynamic formation, roles, coordinator behavior, delegation, handoffs and loop prevention, topology changes, bounded scale-up/down, rebalancing, health monitoring, graph queries, majority and weighted consensus, aggregation, SQLite learning, scheduler leases, M12 worker integration, forced failures, risk authorization, lifecycle cancellation, explainability, and a 100-agent simulation.

The benchmark uses 100 registered agents and 1,000 task units. It reports measured formation, delegation, completion, failure/health, rebalancing, consensus, aggregation, memory lookup, throughput, and end-to-end timings. It does not claim production capacity from a local development machine.

## Limitations

M13 is deterministic and does not provide neural planning or generated model reasoning. The swarm registry and graph are process-local; durable event evidence exists, but a complete swarm snapshot rehydration protocol is not yet implemented. The learning queue remains in-process. A distributed queue, shared rate-limit state, multi-host lease authority, worker autoscaling across machines, chaos testing, container/kernel hardening, TLS deployment, secret-manager integration, and independent security review remain production work. Consensus is not Byzantine fault tolerant, and benchmark measurements are local observations rather than service-level guarantees.
