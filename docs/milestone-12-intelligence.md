# Milestone 12 — Autonomous Intelligence and Orchestration

M12 adds a deterministic autonomous orchestration layer above the existing Helix runtime. Its job is to turn a human- or API-supplied goal into a typed, explainable, policy-checked execution plan, select compatible agents, run bounded work through the existing scheduler and worker path, evaluate evidence, and replan only when the configured limits permit it. M12 does not replace the scheduler, worker pool, registry, router, memory backend, policy engine, sandbox manager, or MCP authorization boundary.

## Design principles

| Principle | M12 behavior | Safety consequence |
|---|---|---|
| Deterministic core | Goal analysis, decomposition, planning, validation, evaluation, and replanning use typed rules and stable ordering. | Tests and recovery do not depend on invented model output. |
| Capability first | Required capabilities are hard constraints before reputation, specialization, cost, latency, exploration, or learning hints. | A learned preference cannot authorize an incompatible agent. |
| Bounded autonomy | `maxReplans`, `maxRetriesPerStep`, `maxIterations`, task depth, fan-out, and plan size are enforced. | Failure cannot create an unbounded autonomous loop. |
| Default-deny security | High- and critical-risk goals require an explicit `approvedBy` authorization. Existing policy and sandbox controls remain authoritative. | Planning cannot turn into implicit permission to execute. |
| Durable evidence | State transitions, selections, step outcomes, replans, and evaluation records are persisted as sanitized events. | Restart recovery can reconstruct state without storing private chain-of-thought or secrets. |
| Existing-runtime reuse | Execution delegates to Helix's scheduler, worker path, router, memory, learning, and policy components. | M12 avoids a second execution engine or security bypass. |

## Goal model and analysis

A `Goal` contains a stable identifier, title, description, requester, creation time, optional expected outcome, constraints, and optional authorization. `analyzeGoal()` deterministically infers a category, capabilities, complexity, risk, recommended topology, dependencies, and expected agent types. The supported categories are software, security, research, documentation, operations, and general.

The analysis is advisory until planning and validation complete. Risk is inferred from explicit security, production, destructive, credential, deployment, or incident language. Security-sensitive plans receive stricter validation, and high or critical plans cannot execute without explicit authorization. The analysis never claims to understand unstated requirements and does not call an LLM.

## Decomposition and planning

`decomposeGoal()` maps a goal category to a bounded task template. A software goal can include analysis, design, implementation, testing, security review, and final review; security, research, documentation, operations, and general goals use narrower templates. The planner assigns stable step IDs, dependencies, depth, retry limits, parallelizability, required capabilities, and preferred agent types.

The limits are explicit and configurable. Plan construction rejects or truncates work beyond maximum task count, depth, fan-out, and iterations rather than silently expanding the graph. The result is an `ExecutionPlan` with a topology recommendation and a plan-level risk classification.

## Validation and authorization

`PlanValidator` checks duplicate IDs, missing dependencies, dependency cycles, capability satisfiability, topology constraints, and security requirements. It uses the current `AgentRegistry` to verify that every required capability has at least one eligible agent. It also enforces stricter rules for critical plans, including hierarchical coordination and explicit security review where required.

Validation is not authorization. A valid plan can still be denied by the policy engine, by MCP actor permissions, by memory ACLs, or by sandbox policy. High- and critical-risk execution requires an explicit authorization record or an `approvedBy` value supplied through the authorized orchestration surface.

## Agent selection and team formation

`IntelligenceAgentSelector` filters unhealthy, unavailable, excluded, or capability-incompatible agents before scoring candidates through the existing `AgentRouter`. Score inputs may include health, reputation, specialization, cost, latency, exploration, and bounded learning hints. The learning contribution is constrained to the existing M10 limit of at most ten percent of routing influence and is never used to override a hard capability mismatch.

The selected agents are grouped into a `SwarmTeam` with a coordinator, step assignments, role metadata, and the plan's recommended topology. Existing `SwarmCoordinator` behavior remains responsible for coordination semantics. M12 records the rationale and selected IDs, not hidden reasoning or secret data.

## Execution state machine

The orchestrator persists a state machine with the following terminal and non-terminal states:

```text
CREATED → ANALYZING → PLANNING → VALIDATING → READY → RUNNING
                                                        ↓
                                  REPLANNING ← EVALUATING
                                      ↓          ↓       ↓
                                  RUNNING     FAILED  COMPLETED
                                                        ↓
                                                    CANCELLED
```

The actual transition guard rejects invalid jumps. `run()` drives the bounded lifecycle; the individual methods (`createGoal`, `analyzeGoal`, `createPlan`, `validatePlan`, `executePlan`, `observe`, `evaluate`, `replan`, `cancel`, `authorize`, and `status`) support API, CLI, SDK, and MCP use cases. Cancellation is durable and prevents a later worker completion from incorrectly changing a terminal cancellation state.

Each executable step is recorded with status, selected agent, attempts, start and finish timestamps, output metadata, error category, and timeout information. The orchestration result reports state, step records, evaluation, replans, team, and event identifiers. The worker and sandbox layers remain responsible for actual command execution and resource controls.

## Evaluation and bounded replanning

`OrchestrationEvaluator` scores only observable evidence: completed steps, dependency satisfaction, output presence, retries, timeouts, reliability, security violations, and goal coverage. It does not create fake success scores. A failed or timed-out step can produce a `ReplanDecision` when an alternative agent, dependency adjustment, or bounded retry is available.

Replanning recalls relevant M10 memory through the existing ACL, namespace, provenance, and sanitization path. It may exclude failed agents, select an alternative, or return an explicit no-alternative reason. The orchestrator stops when `maxReplans`, `maxRetriesPerStep`, or `maxIterations` is reached. Failed outcomes are persisted as sanitized learning evidence; successful outcomes are persisted only after the execution evidence is available.

## Memory and learning integration

Before planning and replanning, M12 may query SQLite-backed M10 memory for relevant routing hints and prior patterns. Memory is advisory: it cannot modify a goal's security classification, bypass plan validation, or authorize an action. ACL checks, namespaces, ownership, visibility, provenance, confidence, and secret-safe sanitization remain enforced by the memory backend.

After execution, the existing `PersistentLearningEngine` records bounded solution, routing, agent-experience, and failure-pattern evidence. Duplicate replay keys preserve idempotency. Runtime learning may be queued asynchronously, and `flushLearning()` remains the explicit durability barrier. The orchestration record exposes memory recall and learning counters so operators can distinguish measured retrieval from execution evidence.

## External surfaces

The runtime exposes `createOrchestrator()`. The CLI adds goal creation and analysis, plan creation, validation, inspection, orchestration execution, status, and cancellation. The API adds versioned goal, plan, and orchestration lifecycle routes. M11 MCP adds fourteen typed intelligence tools, three protected resources, and four policy-aware prompts. These surfaces reuse the existing MCP actor authorization, rate limiting, audit sanitization, API authentication, policy engine, and event store.

| Surface | Representative operations | Authorization boundary |
|---|---|---|
| Runtime/SDK | Create, analyze, plan, validate, execute, observe, evaluate, replan, cancel, explain | Runtime policy and explicit authorization |
| CLI | `helix goal`, `helix plan`, `helix orchestrate` | Local actor and runtime authorization |
| API | `/api/v1/goals`, `/api/v1/plans`, `/api/v1/orchestrations` | API bearer authentication when configured, then runtime policy |
| MCP | `helix_goal_*`, `helix_plan_*`, `helix_orchestrator_*`, intelligence resources/prompts | Existing M11 actor roles, rate limits, audit, and policy |

## Verification and limitations

The M12 suite contains twenty deterministic scenarios covering goal inference, category-aware decomposition, dependency and capability validation, topology and security rules, agent selection, team formation, lifecycle execution, worker failure, timeout, retry limits, cancellation, authorization, memory learning, sanitization, state guards, explainability, metrics, restart recovery, and a 100-agent capability-safe simulation.

The benchmark measures local latency for analysis, planning, validation, 1,000 capability-safe agent-selection task units with 100 registered agents, one full orchestration, resource usage, and measured replanning/completion counters. These results are development-machine measurements, not production capacity guarantees. M12 does not provide a neural planner, distributed queue, multi-process worker autoscaling, automatic human approval, or production security certification. Those remain explicit extension and deployment concerns.

## References

[1]: ../packages/intelligence/src/goal.ts "Deterministic goal analysis"
[2]: ../packages/intelligence/src/decomposer.ts "Bounded category-aware decomposition"
[3]: ../packages/intelligence/src/planner.ts "Intelligence planner"
[4]: ../packages/intelligence/src/plan-validator.ts "Plan validator"
[5]: ../packages/intelligence/src/agent-selector.ts "Capability-first agent selector"
[6]: ../packages/intelligence/src/orchestrator.ts "Helix orchestrator"
[7]: ../packages/intelligence/src/replanner.ts "Bounded replanner"
[8]: ../packages/intelligence/src/evaluator.ts "Evidence-based evaluator"
[9]: ../packages/memory/src/sqlite.ts "SQLite memory backend"
[10]: ../packages/learning/src/intelligence.ts "Persistent learning engine"
