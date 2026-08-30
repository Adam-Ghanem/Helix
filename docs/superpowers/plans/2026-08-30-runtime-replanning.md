# Durable Runtime Replanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, durable runtime plan repair after task failures while preserving completed work and audit history.

**Architecture:** `TaskGraph` gets an atomic failed-task supersession primitive. The runtime receives an injectable `RuntimeReplanner`, tracks per-execution revision state from events, validates proposals against task/replan limits, emits durable revision events, and resumes the graph. The default replanner creates one conservative repair task.

**Tech Stack:** TypeScript 5.9, Node.js 22 test runner, existing EventStore/TaskGraph/HelixRuntime.

**Spec:** `docs/superpowers/specs/2026-08-30-runtime-replanning-design.md`

## Global Constraints

- `maxReplans` defaults to 2 and must be a non-negative integer.
- Completed tasks are immutable during replanning.
- Failed tasks are retained as `skipped` audit records after successful supersession.
- Replanning never exceeds `execution.budget.maxTasks`.
- Revision state must rebuild from the append-only event log.
- Invalid proposals fail closed and do not partially mutate the graph.

---

### Task 1: TaskGraph atomic supersession

**Files:**
- Modify: `packages/planner/src/index.ts`
- Test: `tests/runtime-replanning.test.ts`

**Interfaces:**
- Produces: `TaskGraph.supersedeFailed(taskId, replacements, executionId): { superseded: TaskRecord; replacements: TaskRecord[] }`
- Replacement specs use `title`, `description`, and optional `estimatedMs`; dependencies are derived safely by the graph.

- [ ] **Step 1: Write the failing graph test**

Create a failed middle task with an already-completed dependency and a pending downstream task. Assert supersession keeps completed work unchanged, marks the failed task skipped, creates a replacement chain, and rewires downstream dependencies to the final replacement.

- [ ] **Step 2: Run CI and confirm RED**

Expected: typecheck/test failure because `supersedeFailed` does not exist.

- [ ] **Step 3: Implement atomic supersession**

Clone the current task/estimate maps, validate failed status and non-empty replacement specs, append replacement tasks, rewire downstream non-completed tasks, mark the original skipped, validate the graph, and roll back maps on any exception.

- [ ] **Step 4: Run CI and confirm GREEN for graph behavior**

Expected: typecheck/build/tests pass through the new graph test.

---

### Task 2: Runtime replanner contract and bounded repair loop

**Files:**
- Modify: `packages/planner/src/index.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `tests/runtime-replanning.test.ts`

**Interfaces:**
- Produces: `RuntimeReplanner`, `ReplanContext`, `ReplanProposal`, `DeterministicFailureReplanner`.
- `RuntimeOptions` gains `replanner?: RuntimeReplanner` and `maxReplans?: number`.
- `ExecutionView` gains `planRevision: number`.

- [ ] **Step 1: Write failing runtime repair tests**

Use a provider that fails the original `Execute bounded work` task but succeeds the replacement. Assert final execution completes, original task is skipped, replacement and downstream evaluation complete, completed pre-failure results are preserved, and one `plan.replanned` event exists.

- [ ] **Step 2: Run CI and confirm RED**

Expected: missing replanner/runtime revision APIs or static execution failure.

- [ ] **Step 3: Implement minimal repair lifecycle**

After each ready-task batch, inspect failed tasks. For each failed task while below `maxReplans`, request a proposal, validate proposal shape and remaining task budget, apply `supersedeFailed`, append `task.superseded` plus replacement `task.created` events, increment the revision, append `plan.replanned`, update `execution.taskIds` and `execution.usage.tasks`, and continue execution.

If proposal is absent/invalid/over budget, append `plan.replan_rejected` and leave the failed task unchanged so final execution status becomes failed.

- [ ] **Step 4: Run CI and confirm GREEN**

Expected: repaired execution completes and existing runtime tests remain green.

---

### Task 3: Durable rebuild and hard limits

**Files:**
- Modify: `packages/runtime/src/index.ts`
- Test: `tests/runtime-replanning.test.ts`

**Interfaces:**
- Rebuild consumes `task.superseded` and `plan.replanned`.
- `view(executionId)` returns durable `planRevision`.

- [ ] **Step 1: Write failing restart and limit tests**

Assert a fresh runtime over the same data directory restores revision 1, skipped original task, replacement tasks, and preserved completed results. Add repeated-failure coverage proving `maxReplans: 1` yields exactly one revision then fails. Add `maxTasks: 4` coverage proving the default four-task plan cannot append a repair and emits `plan.replan_rejected` without exceeding four tasks.

- [ ] **Step 2: Run CI and confirm RED**

Expected: revision/rebuild or hard-limit assertions fail before implementation.

- [ ] **Step 3: Implement rebuild and rejection semantics**

Track revisions in a runtime map, restore skipped status on `task.superseded`, increment/restore the exact revision from `plan.replanned`, and ensure rejected proposals never mutate task ids or usage counts.

- [ ] **Step 4: Run full verification**

Run the repository CI-equivalent sequence: install, typecheck, build, tests. Expected: all pass with zero failures.

- [ ] **Step 5: Open PR and merge only after PR CI succeeds**

Use a squash merge pinned to the verified head SHA, then verify the merge commit on `main`.
