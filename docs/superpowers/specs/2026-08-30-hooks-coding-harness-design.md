# Helix Hooks and Coding Harness Design

## Status

Approved direction for the next Helix tranche after autonomous agents and durable swarms.

## Goal

Build a provider-neutral coding harness that turns Helix from an orchestration library into an active coding workflow coordinator. The harness must coordinate task routing, memory recall, policy gates, editing/command lifecycle events, review/testing/judging, durable session state, and learning feedback while remaining decoupled from any single coding-agent vendor.

## Context

Helix already has a durable runtime, daemon/workers, real MCP transports, hybrid vector memory, 60+ agent profiles, autonomous delegation, policy gates, supervised swarms, and durable swarm state. The current `packages/hooks` directory is empty, while the CLI and runtime expose clean orchestration boundaries that can host a hook engine without a large refactor.

Ruflo demonstrates the value of lifecycle hooks such as pre-task, post-task, pre-edit, post-edit, pre-command, post-command, session-start, and session-end. Helix should implement the same class of capability independently, with stronger provider neutrality and explicit security boundaries.

## Design Principles

1. **Provider-neutral core.** Helix owns orchestration state and lifecycle semantics. Codex, Claude Code, and future coding agents are adapters.
2. **Default-deny execution.** Hooks may enrich, route, annotate, or block. They must not silently bypass Helix policy decisions.
3. **Durable sessions.** Coding sessions, hook outcomes, artifacts, quality gates, and adapter executions survive process restart.
4. **Structured evidence.** Review/test/judge outputs are typed records, not opaque prose where avoidable.
5. **Fail closed for security gates, fail open only for optional telemetry/learning hooks.**
6. **TDD for production behavior.** Every behavior is introduced by a failing test before implementation.
7. **No vendor-specific assumptions in core packages.** Vendor flags, JSON formats, process invocation, and session identifiers live in adapter files.
8. **No unrestricted shell execution.** Adapter process spawning is bounded by executable allowlists, cwd validation, environment allowlists, timeout, output limits, and cancellation.

## Scope

### In scope

- Hook registry and deterministic hook execution pipeline.
- Core lifecycle events:
  - `session-start`
  - `session-end`
  - `pre-task`
  - `post-task`
  - `pre-edit`
  - `post-edit`
  - `pre-command`
  - `post-command`
  - `pre-tool`
  - `post-tool`
  - `on-failure`
  - `pre-review`
  - `post-review`
- Hook priorities, filters, timeout, blocking decisions, annotations, emitted evidence, and failure policy.
- Durable coding session store.
- Coding-agent adapter interface.
- Process-based adapter runner with strict safety controls.
- Claude Code adapter using non-interactive structured output.
- Generic process adapter suitable for Codex CLI or another local coding agent without coupling the core to unstable vendor-specific flags.
- Orchestrated coding workflow:
  - task intake
  - memory recall
  - agent routing/delegation
  - implementation adapter call
  - reviewer gate
  - tester gate
  - judge decision
  - post-task memory/learning update
- CLI commands to start/resume/inspect coding sessions and invoke hooks.
- Durable evidence records for changed files, commands, reviews, tests, and final verdicts.

### Out of scope for this tranche

- OS/container sandbox implementation itself; the harness consumes the existing sandbox boundary and must not claim container isolation.
- IDE plugins.
- Marketplace/distribution of third-party hooks.
- Automatic git commit/push/merge.
- Direct GitHub PR creation from the coding harness.
- Neural training or LoRA-style model updates.
- A vendor-specific Codex implementation that depends on undocumented flags. The generic adapter contract must be ready for a dedicated Codex adapter once its invocation contract is verified.

## Architecture

The tranche is split into five focused units:

1. **Hook Engine (`packages/hooks`)**
   Owns lifecycle event types, hook registration, matching, ordering, execution, timeout, blocking, and result aggregation.

2. **Coding Session Store (`packages/coding`)**
   Owns durable session state, task attempts, adapter runs, file/command evidence, quality gates, final verdicts, and restart recovery.

3. **Coding Agent Adapters (`packages/coding/adapters`)**
   Translate Helix `CodingAgentRequest` objects into a specific external coding-agent invocation and normalize the result into `CodingAgentResult`.

4. **Coding Harness (`packages/coding/harness.ts`)**
   Coordinates hooks, memory, autonomous agents, adapter execution, review/test/judge stages, policy decisions, and persistence.

5. **CLI Integration (`apps/cli`)**
   Provides user-facing commands without embedding orchestration logic in the CLI.

## Hook Engine

### Event model

```ts
export type HookEventName =
  | 'session-start'
  | 'session-end'
  | 'pre-task'
  | 'post-task'
  | 'pre-edit'
  | 'post-edit'
  | 'pre-command'
  | 'post-command'
  | 'pre-tool'
  | 'post-tool'
  | 'on-failure'
  | 'pre-review'
  | 'post-review';
```

Every event carries a shared envelope:

```ts
export interface HookContext<T = Record<string, unknown>> {
  event: HookEventName;
  sessionId: string;
  executionId?: string;
  taskId?: string;
  agentId?: string;
  cwd: string;
  timestamp: string;
  payload: T;
  metadata: Record<string, unknown>;
}
```

A hook returns a structured decision:

```ts
export interface HookResult {
  hookId: string;
  action: 'continue' | 'block';
  reason?: string;
  annotations?: Record<string, unknown>;
  evidence?: string[];
  warnings?: string[];
}
```

### Registration

```ts
export interface HookDefinition {
  id: string;
  events: HookEventName[];
  priority: number;
  critical: boolean;
  timeoutMs: number;
  matcher?: (context: HookContext) => boolean;
  handler: (context: HookContext) => Promise<HookResult>;
}
```

Rules:

- Lower numeric `priority` executes first.
- Equal priorities preserve registration order.
- A `block` result stops later non-audit hooks for that event.
- Audit hooks marked `alwaysRun: true` may still record the blocked attempt, but cannot change the final block decision.
- A timeout/error from a `critical` hook blocks the operation.
- A timeout/error from a non-critical hook emits a warning and continues.
- Hook results are durable through the coding session store and optionally mirrored into Helix EventStore.

## Built-in Hooks

The initial built-ins are deliberately small and composable.

### `TaskPreparationHook`

Runs on `pre-task`:

- recalls relevant hybrid memory for the session subject;
- requests capability recommendations from `AgentRegistry` / autonomous delegation;
- attaches memory hits and recommended roles to annotations;
- never blocks solely because memory is unavailable.

### `CommandSafetyHook`

Runs on `pre-command` and is critical:

- validates command shape;
- rejects explicitly denied command patterns;
- delegates final authorization to the existing Helix policy/sandbox boundary;
- records the reason for allow/block.

### `EditContextHook`

Runs on `pre-edit`:

- validates the file is inside allowed workspace roots;
- recalls file/task-related memory;
- attaches known evidence and previous failures.

### `OutcomeLearningHook`

Runs on `post-task`, `post-edit`, `post-command`, and `on-failure`:

- converts successful/failed outcomes into existing learning trajectories and memory records;
- is non-critical so learning failures do not invalidate otherwise successful engineering work.

### `QualityGateHook`

Runs on `pre-review` / `post-review`:

- enforces that implementation cannot be declared accepted unless required review/test/judge stages have durable evidence.

## Durable Coding Session Model

```ts
export type CodingSessionStatus =
  | 'created'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

export interface CodingSessionRecord {
  id: string;
  goal: string;
  cwd: string;
  adapter: string;
  status: CodingSessionStatus;
  createdAt: string;
  updatedAt: string;
  executionId?: string;
  activeTaskId?: string;
  attempt: number;
  evidenceIds: string[];
  finalVerdict?: 'accepted' | 'rejected';
  error?: string;
}
```

Evidence is append-only:

```ts
export interface CodingEvidenceRecord {
  id: string;
  sessionId: string;
  type:
    | 'hook'
    | 'adapter-output'
    | 'file-change'
    | 'command'
    | 'review'
    | 'test'
    | 'judge'
    | 'failure';
  createdAt: string;
  data: Record<string, unknown>;
}
```

Persistence uses atomic file replacement and serialized writes, following the durability style already used elsewhere in Helix. State restoration must be deterministic after process restart.

## Coding Agent Adapter Contract

```ts
export interface CodingAgentRequest {
  sessionId: string;
  goal: string;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  deniedTools: string[];
  maxTurns: number;
  timeoutMs: number;
  context: Array<{ kind: string; content: string }>;
}

export interface CodingAgentResult {
  adapter: string;
  success: boolean;
  output: string;
  structured?: Record<string, unknown>;
  sessionRef?: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode?: number }>;
  usage?: { tokens?: number; costUsd?: number };
  error?: string;
}

export interface CodingAgentAdapter {
  readonly name: string;
  available(): Promise<boolean>;
  run(request: CodingAgentRequest): Promise<CodingAgentResult>;
  resume?(sessionRef: string, request: CodingAgentRequest): Promise<CodingAgentResult>;
}
```

The harness may select an adapter explicitly or through an adapter registry. Adapter selection must not be entangled with model routing.

## Process Adapter Safety

A shared `BoundedProcessRunner` is the only component allowed to spawn external coding CLIs.

Required controls:

- explicit executable allowlist;
- exact argument array, never `shell: true`;
- cwd must resolve inside configured workspace roots;
- environment variables passed through an allowlist;
- authentication secrets are inherited only if explicitly named in adapter configuration;
- configurable timeout with SIGTERM then bounded SIGKILL fallback;
- stdout/stderr byte limits;
- cancellation via `AbortSignal`;
- no implicit permission bypass flags;
- result includes exit code and truncated-output metadata when limits are reached.

## Adapter Strategy

### Claude Code Adapter

Claude Code has a documented non-interactive mode and structured output options. The adapter may use those documented surfaces to execute a bounded prompt and normalize output. The Helix adapter must not enable dangerous permission bypass flags automatically.

### Generic CLI Adapter

This adapter is configured with:

- executable;
- static arguments;
- prompt transport (`argv` or stdin);
- optional JSON parser;
- documented session-resume arguments if available;
- executable-specific env allowlist.

The generic adapter is the initial path for Codex-style integration until a dedicated, verified adapter contract is implemented. This avoids baking unstable or undocumented vendor CLI behavior into Helix core.

## Coding Harness Workflow

`CodingHarness.run()` implements one durable engineering attempt:

1. Load/create coding session.
2. Fire `session-start` for a new session.
3. Fire `pre-task`.
4. If blocked, persist block evidence and stop.
5. Recall hybrid memory and attach the top relevant evidence to the adapter context.
6. Select/spawn implementation agent(s) using the autonomous agent system.
7. Run implementation adapter.
8. Normalize changed files and commands into evidence records.
9. Fire corresponding `post-edit` / `post-command` hooks for reported operations.
10. Run reviewer stage using a reviewer agent/provider request.
11. Run tester stage using configured verification commands through the bounded process/sandbox boundary.
12. Run judge stage using review + test evidence.
13. Fire `post-review` and `post-task`.
14. Persist outcome to memory/learning.
15. Mark the session `completed` only if the judge verdict is accepted and all required gates exist.
16. Fire `session-end` when the session is explicitly closed or reaches a terminal state.

If an implementation adapter fails, the harness records failure evidence, fires `on-failure`, and marks the attempt failed. A later resume creates a new attempt while retaining prior evidence.

## Review, Test, and Judge Contracts

Reviewer output:

```ts
export interface ReviewVerdict {
  approved: boolean;
  findings: Array<{
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
    message: string;
    file?: string;
  }>;
  summary: string;
}
```

Tester output:

```ts
export interface TestVerdict {
  passed: boolean;
  commands: Array<{
    command: string;
    exitCode: number;
    durationMs: number;
  }>;
  summary: string;
}
```

Judge output:

```ts
export interface JudgeVerdict {
  accepted: boolean;
  reason: string;
  requiredFixes: string[];
  confidence: number;
}
```

Default acceptance policy:

- reviewer must not contain unresolved `critical` or `high` findings;
- tester must pass all required commands;
- judge must return `accepted: true` with confidence >= `0.60`;
- any critical hook block overrides judge acceptance.

## CLI Surface

Initial commands:

```text
helix code run <goal> [--adapter <name>] [--json]
helix code resume <session-id> [--json]
helix code session <session-id> [--json]
helix code sessions [--json]
helix hooks list [--json]
helix hooks run <event> --session <id> [--payload <json>] [--json]
```

`helix code run` remains foreground in this tranche. Background coding jobs can later reuse the daemon queue after the foreground lifecycle is proven stable.

## Error Handling

- Unknown hook event: reject input.
- Duplicate hook ID: reject registration.
- Critical hook timeout/error: block operation and persist failure evidence.
- Optional hook timeout/error: warning evidence, continue.
- Invalid workspace path: block before spawning any process.
- Adapter unavailable: fail before session enters implementation stage.
- Adapter malformed structured output: preserve raw output, mark adapter result failed.
- Reviewer/tester/judge failure: session fails or rejects; never silently marks accepted.
- Persistence write failure: fail closed for session-state transitions.
- Learning/memory update failure after final verdict: record warning; do not rewrite a verified accepted verdict.

## Security Requirements

- No `shell: true` process spawning.
- No automatic `--dangerously-skip-permissions`-style option.
- All file paths normalized and constrained to workspace roots.
- Secret values never copied into durable hook/evidence payloads.
- Hook annotations pass through a sanitizer before persistence.
- External adapter stderr/stdout are bounded before persistence.
- Command hooks run before command execution whenever Helix itself controls the process.
- Vendor-reported commands are evidence only; they are not treated as proof that Helix authorized them.
- Final acceptance is impossible without durable test evidence.

## Testing Strategy

### Hook tests

- deterministic priority order;
- match filtering;
- critical failure blocks;
- optional failure warns and continues;
- block short-circuits non-audit hooks;
- timeout behavior;
- sanitized durable result records.

### Session-store tests

- create/update/reload;
- append-only evidence;
- restart restoration;
- attempt increment on resume;
- terminal-state invariants;
- concurrent serialized writes.

### Process-runner tests

- allowlisted executable succeeds;
- unknown executable denied;
- cwd escape denied;
- env filtering;
- timeout termination;
- output truncation;
- abort/cancellation;
- no shell interpolation.

### Adapter tests

- unavailable executable;
- structured success normalization;
- malformed JSON fallback/failure;
- non-zero exit result;
- session resume where supported.

### Harness integration tests

- complete successful coding workflow with deterministic fake adapter/provider;
- pre-task block prevents adapter invocation;
- adapter failure fires `on-failure` and persists evidence;
- reviewer rejection prevents acceptance;
- failing tests prevent acceptance;
- judge rejection prevents acceptance;
- restart/resume preserves prior evidence;
- memory is recalled before adapter execution and outcome stored after completion.

No test may require a real paid coding-agent account. Vendor adapter tests use deterministic fixture processes; an optional smoke test can be documented separately for local users.

## Alternatives Considered

### A. Vendor-first Claude/Codex integration

Build directly around one coding CLI and make Helix follow its event model.

**Rejected:** fastest demo, but couples orchestration semantics to vendor flags, permissions, and output formats. It undermines Helix's provider-neutral identity.

### B. MCP-only coding integration

Treat every coding agent as an MCP server/tool.

**Rejected as the only path:** MCP is useful for tools but does not by itself model coding session lifecycle, file/command evidence, external CLI resume semantics, and quality gates cleanly.

### C. Provider-neutral harness with adapters

Helix owns lifecycle/session/security contracts; adapters translate vendor-specific invocation details.

**Selected:** slightly more initial structure, but clean boundaries, testability, safer execution, and straightforward support for multiple coding agents.

## Delivery Boundaries

The tranche is complete only when:

1. Hook engine behavior is implemented and tested.
2. Durable coding sessions restore after restart.
3. Bounded process runner enforces the listed safety controls.
4. At least one concrete structured coding-agent adapter is implemented plus the generic adapter.
5. The harness executes implementation -> review -> test -> judge end-to-end in deterministic integration tests.
6. CLI commands expose run/resume/session/hooks functionality.
7. `pnpm typecheck`, `pnpm build`, and `pnpm test` pass on the feature branch and again on `main` after merge.
8. Documentation makes no claim that OS/container isolation exists unless that separate sandbox tranche has actually implemented it.
