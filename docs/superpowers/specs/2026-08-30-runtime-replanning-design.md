# Durable Runtime Replanning Design

## Goal

Allow a running Helix execution to repair a failed task by creating a bounded plan revision instead of immediately failing the whole static graph.

## Design

Helix will keep the original task as durable audit evidence and supersede it rather than deleting or rewriting history. A failed task that is successfully replanned becomes `skipped`; one or more replacement tasks are appended to the graph. The first replacement inherits the failed task's completed dependencies, replacement tasks form a chain, and downstream incomplete tasks are rewired from the failed task to the final replacement task.

The runtime owns revision lifecycle. It tracks a per-execution revision counter rebuilt from `plan.replanned` events, asks an injected `RuntimeReplanner` for a proposal, validates the proposal against `maxTasks` and a runtime `maxReplans` ceiling, applies it atomically, emits `task.superseded`, `task.created`, and `plan.replanned` events, then continues the normal ready-task loop.

## Replanner Contract

`RuntimeReplanner` receives a structured context containing the execution, the failed task, current tasks, current revision, remaining task capacity, and the failure reason. It returns either `null` to decline repair or a `ReplanProposal` containing a non-empty reason and one or more replacement task specifications.

The default implementation is deterministic and conservative: it proposes a single repair task derived from the failed task. More advanced model-backed or policy-backed replanners can be injected later without changing the runtime lifecycle.

## Safety and Bounds

- `maxReplans` defaults to 2 and must be a non-negative integer.
- A proposal cannot make the graph exceed `execution.budget.maxTasks`.
- Empty or malformed proposals are rejected without mutating the graph.
- Completed tasks are never changed by replanning.
- Replacement application is atomic: validation failure restores the previous graph.
- The original failed task is preserved and marked `skipped` only after a valid replacement graph exists.
- If no valid replan is available, execution fails normally.
- Runtime, token, cost, and agent budgets continue to apply unchanged.

## Durability and Recovery

`task.superseded`, replacement `task.created`, and `plan.replanned` are append-only events. `HelixRuntime.rebuild()` restores skipped status, replacement tasks, rewired dependency state, and the revision count. `ExecutionView` exposes `planRevision` so callers can inspect recovery state directly.

## Observability

A successful repair emits `plan.replanned` with revision, failed task id, replacement ids, and reason. A declined or invalid proposal emits `plan.replan_rejected` with the failed task id and reason. Existing task and execution events remain authoritative.

## Testing

Tests must prove:

1. A provider failure can be repaired and downstream execution completes.
2. Completed tasks keep their results across the plan revision.
3. Restart/rebuild restores replacement tasks, skipped superseded task, and revision number.
4. `maxReplans` bounds repeated failures.
5. `maxTasks` rejects a repair without exceeding budget.
6. Existing runtime, recovery, and retry tests remain green.
