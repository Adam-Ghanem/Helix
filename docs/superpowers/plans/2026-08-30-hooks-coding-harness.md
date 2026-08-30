# Helix Hooks and Coding Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, provider-neutral coding harness with lifecycle hooks, bounded external coding-agent adapters, review/test/judge quality gates, and CLI session control.

**Architecture:** Add a deterministic hook engine in `packages/hooks`, a durable coding-session/evidence store in `packages/coding`, bounded process/adapters under `packages/coding/adapters`, and a `CodingHarness` that composes memory, agents, hooks, adapters, and quality gates. Keep vendor-specific process arguments outside the core and keep the enforcement boundary honest: Helix pre-authorizes only operations it directly executes.

**Tech Stack:** TypeScript 5.x, Node.js 22, Node test runner, existing Helix memory/agents/security/runtime packages, atomic JSON persistence, `child_process.spawn` with `shell: false`.

**Spec:** `docs/superpowers/specs/2026-08-30-hooks-coding-harness-design.md`

## Global Constraints

- Provider-neutral core; vendor-specific flags and parsing stay in adapter files.
- Critical hook timeout/error fails closed; optional hook timeout/error emits warnings and continues.
- No unrestricted shell execution and no `shell: true`.
- Executable, cwd, environment, timeout, cancellation, and output sizes are bounded.
- Coding sessions and evidence survive process restart.
- External coding-CLI internal commands/edits are evidence unless a vendor interception surface is explicitly integrated.
- Session completion requires review, test, and judge evidence plus the default acceptance policy.
- Production behavior follows TDD: failing test first, then minimal implementation.

---

### Task 1: Deterministic Hook Engine

**Files:**
- Create: `packages/hooks/src/index.ts`
- Test: `tests/hooks.test.ts`
- Delete after implementation: `packages/hooks/.gitkeep`

**Interfaces:**
- Produces `HookEventName`, `HookContext`, `HookResult`, `HookDefinition`, `HookRunResult`, `HookEngine`.
- `HookEngine.register(definition)` rejects duplicate ids and invalid timeouts.
- `HookEngine.run(context)` executes matched hooks by ascending priority and registration order, stops ordinary hooks after block, still executes `alwaysRun` audit hooks, and aggregates annotations/evidence/warnings.

- [ ] **Step 1: Write failing hook tests**

Create `tests/hooks.test.ts` covering ordering, matcher filtering, block short-circuit, `alwaysRun`, critical timeout fail-closed, non-critical timeout fail-open, and duplicate-id rejection.

- [ ] **Step 2: Verify RED**

Run CI on the test-only commit. Expected: TypeScript cannot resolve `packages/hooks/src/index.js` or missing hook APIs.

- [ ] **Step 3: Implement minimal hook engine**

Use `Promise.race` with a timer per handler. Convert thrown errors/timeouts into a blocking result for critical hooks and warnings for non-critical hooks. Merge annotations shallowly in execution order and append evidence/warnings in execution order.

- [ ] **Step 4: Verify GREEN**

Run `pnpm typecheck && pnpm build && pnpm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Commit message: `feat: add deterministic lifecycle hook engine`.

---

### Task 2: Durable Coding Session and Evidence Store

**Files:**
- Create: `packages/coding/src/store.ts`
- Create: `packages/coding/src/types.ts`
- Create: `packages/coding/src/index.ts`
- Test: `tests/coding-store.test.ts`

**Interfaces:**
- Produces `CodingSessionRecord`, `CodingEvidenceRecord`, `CodingSessionStatus`, `ReviewVerdict`, `TestVerdict`, `JudgeVerdict`.
- Produces `CodingSessionStore({ stateFile })` with `init()`, `createSession()`, `getSession()`, `listSessions()`, `updateSession()`, `appendEvidence()`, `evidenceForSession()`.
- Store writes through a serialized write queue to a temporary file then atomic rename.
- Evidence is append-only; session `evidenceIds` is updated atomically with evidence creation.

- [ ] **Step 1: Write failing persistence tests**

Cover create/update/reopen, append-only evidence, deterministic list ordering, rejected unknown session updates, and evidence/session linkage after restart.

- [ ] **Step 2: Verify RED**

Expected: missing coding store modules/APIs.

- [ ] **Step 3: Implement minimal store and types**

Persist one JSON object `{ version: 1, sessions: [...], evidence: [...] }`. Validate ids and copy returned values with `structuredClone`.

- [ ] **Step 4: Verify GREEN**

Run full verification.

- [ ] **Step 5: Commit**

Commit message: `feat: add durable coding session store`.

---

### Task 3: Bounded Process Runner and Coding-Agent Adapters

**Files:**
- Create: `packages/coding/src/process.ts`
- Create: `packages/coding/src/adapters/base.ts`
- Create: `packages/coding/src/adapters/generic.ts`
- Create: `packages/coding/src/adapters/claude.ts`
- Modify: `packages/coding/src/index.ts`
- Test: `tests/coding-adapters.test.ts`

**Interfaces:**
- Produces `CodingAgentRequest`, `CodingAgentResult`, `CodingAgentAdapter`.
- Produces `BoundedProcessRunner` with constructor options `{ allowedExecutables, workspaceRoots, environmentKeys, maxStdoutBytes, maxStderrBytes, killGraceMs }` and `run({ executable, args, cwd, environment, stdin, timeoutMs, signal })`.
- `GenericCliAdapter` accepts executable/static args/prompt transport/parser/env allowlist configuration.
- `ClaudeCodeAdapter` builds only documented non-interactive/structured-output arguments and never permission-bypass arguments.

- [ ] **Step 1: Write failing adapter/process tests**

Use temporary local `.mjs` fixture processes to test allowlist rejection, cwd escape rejection, env filtering, stdin/argv prompt transport, timeout, output truncation metadata, cancellation, generic JSON parsing, and Claude argument construction.

- [ ] **Step 2: Verify RED**

Expected: missing process/adapter APIs.

- [ ] **Step 3: Implement bounded runner**

Use `assertAbsoluteExecutable()` and `validatePath()` from `packages/security`. Spawn with an exact argument array and `shell: false`. Capture bounded stdout/stderr, mark truncation, send SIGTERM on timeout/abort, then SIGKILL after `killGraceMs` if still alive.

- [ ] **Step 4: Implement adapters**

Normalize results into `CodingAgentResult`; do not infer authorization from reported commands/changed files. `available()` checks executable accessibility without invoking a privileged operation.

- [ ] **Step 5: Verify GREEN**

Run full verification.

- [ ] **Step 6: Commit**

Commit message: `feat: add bounded coding agent adapters`.

---

### Task 4: Coding Harness and Quality Gates

**Files:**
- Create: `packages/coding/src/harness.ts`
- Create: `packages/coding/src/builtins.ts`
- Modify: `packages/coding/src/index.ts`
- Test: `tests/coding-harness.test.ts`

**Interfaces:**
- Produces `CodingHarness` with injected dependencies: `store`, `hooks`, `adapter`, optional `memory`, optional `agents`, plus `reviewer`, `tester`, and `judge` functions.
- `run({ goal, cwd, adapter?, allowedTools?, deniedTools?, maxTurns?, timeoutMs? })` creates a session and executes one attempt.
- `resume(sessionId)` reuses durable session/evidence and increments `attempt`.
- Produces built-ins: `createTaskPreparationHook`, `createEditContextHook`, `createOutcomeLearningHook`, `createQualityGateHook`.
- Default acceptance: no unresolved high/critical review finding, all required tests passed, judge accepted with confidence >= 0.60, no critical hook block.

- [ ] **Step 1: Write failing harness tests**

Cover successful accepted workflow, pre-task block, adapter failure/on-failure, failed tester rejection, high-severity review rejection, low-confidence judge rejection, durable resume attempt increment, memory context injection, and terminal `session-end` hook execution.

- [ ] **Step 2: Verify RED**

Expected: missing harness/built-ins APIs.

- [ ] **Step 3: Implement minimal harness**

Persist each stage as evidence before advancing. Treat adapter-reported changed files/commands as evidence and fire post events only; do not pretend pre-authorization occurred for operations internal to the external CLI.

- [ ] **Step 4: Implement built-in hooks**

Use existing `MemoryStore` and `AgentRegistry` APIs where provided. Built-ins must be dependency-injected so tests remain deterministic.

- [ ] **Step 5: Verify GREEN**

Run full verification.

- [ ] **Step 6: Commit**

Commit message: `feat: add durable coding harness quality gates`.

---

### Task 5: CLI Integration

**Files:**
- Modify: `apps/cli/src/index.ts`
- Test: `tests/cli-code.test.ts`

**Interfaces:**
- Adds `helix code run <goal>`, `helix code resume <session-id>`, `helix code session <session-id>`, `helix code sessions`.
- Adds `helix hooks list` and `helix hooks run <event> --session <id> --payload <json>`.
- CLI wiring creates stores/registries and adapters from environment/config; orchestration logic remains in packages.

- [ ] **Step 1: Write failing CLI tests**

Spawn the built CLI against a temp `HELIX_DATA_DIR` using deterministic test adapter configuration. Assert help contains commands, sessions persist, session inspection works, invalid hook payload fails cleanly, and JSON output is valid.

- [ ] **Step 2: Verify RED**

Expected: new commands are unknown.

- [ ] **Step 3: Add minimal CLI handlers**

Keep parsing local and delegate to `CodingHarness`, `CodingSessionStore`, and `HookEngine`.

- [ ] **Step 4: Verify GREEN**

Run full verification.

- [ ] **Step 5: Commit**

Commit message: `feat: expose coding harness through cli`.

---

### Task 6: End-to-End Recovery and Security Regression

**Files:**
- Test: `tests/coding-integration.test.ts`
- Modify only if a test exposes a defect: files from Tasks 1–5.

**Interfaces:**
- No new public API unless required to fix a verified defect.

- [ ] **Step 1: Write integration tests**

Exercise: create session -> run adapter fixture -> record evidence -> restart store/harness -> inspect and resume -> reject cwd escape -> reject non-allowlisted executable -> verify critical hook block survives as durable evidence.

- [ ] **Step 2: Verify RED where a real integration gap exists**

If every integration test passes immediately because Tasks 1–5 already cover the behavior, keep the tests and proceed; do not manufacture a failure by weakening production code.

- [ ] **Step 3: Fix only verified integration defects**

Use the smallest change needed and add a focused regression assertion for each defect.

- [ ] **Step 4: Final verification**

Run `pnpm typecheck`, `pnpm build`, and `pnpm test` on the feature branch. Then open a PR and require the pull-request CI to pass before merge.

- [ ] **Step 5: Merge and verify main**

Squash merge only after PR CI passes. Verify the merge commit on `main` with a fresh CI run before claiming completion.
