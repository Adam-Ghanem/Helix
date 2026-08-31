# Isolated Executable Plugin Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute signed plugin tool/hook code only in persistent strict-isolation workers backed by verified content-addressed artifacts and bounded JSONL RPC.

**Architecture:** Add a content-addressed `PluginArtifactStore`, extend the sandbox with persistent isolated sessions, build a protocol-focused `PluginWorkerManager`, then wire executable contributions into `DurablePluginManager` and CLI lifecycle. The coordinator never imports plugin code; all executable behavior is proxied over bounded JSONL RPC.

**Tech Stack:** TypeScript 5.9, Node.js 22 child processes/streams/crypto/fs, Bubblewrap + prlimit through the existing sandbox package, node:test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-31-isolated-plugin-workers-design.md`

## Global Constraints

- Third-party plugin code must never be dynamically imported into the Helix coordinator.
- Executable plugin workers require `ExecutableSandbox.isolated === true`; no unsafe fallback is permitted.
- Plugin artifact v1 is one regular `.js` or `.mjs` file, maximum 8 MiB.
- Managed artifact bytes must match the signed SHA-256 digest at install and every worker start/restart.
- Network is disabled unless signed manifest permissions include `network:egress` and policy already allowed it.
- JSONL frames are capped at 1 MiB and requests are ID-correlated.
- Worker restart attempts are capped at 3 per manager instance before opening a circuit.
- Enable is transactional; disable/uninstall remain durability-first.
- Existing data-only plugins and one-shot sandbox APIs must remain compatible.

---

### Task 1: Content-addressed plugin artifact store

**Files:**
- Create: `packages/plugins/src/artifacts.ts`
- Modify: `packages/plugins/src/store.ts`
- Modify: `packages/plugins/src/index.ts`
- Test: `tests/plugin-artifacts.test.ts`

**Interfaces:**
- Produces: `ManagedPluginArtifactRecord { digest: string; path: string; size: number }`
- Produces: `PluginArtifactStore({ directory, maxBytes? })`
- Produces: `install(sourcePath: string, expectedDigest: string): Promise<ManagedPluginArtifactRecord>`
- Produces: `verify(record: ManagedPluginArtifactRecord, expectedDigest: string): Promise<ManagedPluginArtifactRecord>`

- [ ] **Step 1: Write failing artifact tests** covering exact digest success, mismatch rejection, symlink rejection, immutable content-addressed reuse, and post-install tamper detection.

- [ ] **Step 2: Run repository CI for the RED commit.** Expected: typecheck/test failure because `PluginArtifactStore` and `ManagedPluginArtifactRecord` do not exist.

- [ ] **Step 3: Implement minimal store.** Use `lstat`, bounded `readFile`, SHA-256, constant-time digest comparison, exclusive temp write + rename, regular-file verification, and containment checks under `<directory>/sha256`.

- [ ] **Step 4: Run full CI.** Expected: artifact tests and all existing tests pass.

- [ ] **Step 5: Review task diff** for path traversal, symlink races, partial-file semantics, and record cloning.

---

### Task 2: Persistent isolated sandbox session primitive

**Files:**
- Modify: `packages/sandbox/src/index.ts`
- Test: `tests/sandbox-session.test.ts`

**Interfaces:**
- Produces: `SandboxSessionRequest { command; args; cwd?; environment?; timeoutMs?; maxFrameBytes? }`
- Produces: `SandboxSession { backend; isolated; writeLine(line); onLine(listener); onExit(listener); close(); kill(); }`
- Extends: `ExecutableSandbox.spawnSession?(request): Promise<SandboxSession>`
- `BubblewrapSandbox.spawnSession()` uses the same isolation plan as one-shot execution.
- `UnsafeProcessSandbox.spawnSession()` may exist for general sandbox compatibility but reports `isolated=false`; plugin worker code must reject it.

- [ ] **Step 1: Write failing tests** proving Bubblewrap session planning keeps no-network/read-only/runtime constraints, line framing is bounded, cancellation/close kill semantics are deterministic, and unsafe sessions are marked non-isolated.

- [ ] **Step 2: Verify RED** on missing `spawnSession`/session types.

- [ ] **Step 3: Implement minimal persistent session runner** with `spawn(..., shell:false)`, bounded incremental stdout line parser, bounded stderr accumulation, write backpressure handling, close grace timeout, and forced kill fallback.

- [ ] **Step 4: Run full CI** and preserve all one-shot sandbox tests.

- [ ] **Step 5: Review** for child-process leaks, unbounded buffering, inherited environment, and duplicate exit settlement.

---

### Task 3: Bounded plugin worker RPC and crash circuit breaker

**Files:**
- Create: `packages/plugins/src/worker.ts`
- Modify: `packages/plugins/src/index.ts`
- Test: `tests/plugin-worker.test.ts`
- Create: `tests/fixtures/plugin-worker.mjs`

**Interfaces:**
- Produces: `PluginWorkerSandboxFactory.create(input): Promise<ExecutableSandbox>`
- Produces: `PluginWorkerManager({ artifacts, sandboxFactory, nodeExecutable, maxRestarts?, handshakeTimeoutMs?, maxFrameBytes? })`
- Produces: `preflight(pluginId, manifest, artifact): Promise<void>`
- Produces: `start(pluginId, manifest, artifact): Promise<void>`
- Produces: `callTool(pluginId, name, input, timeoutMs?): Promise<unknown>`
- Produces: `callHook(pluginId, name, event, context, timeoutMs?): Promise<unknown>`
- Produces: `stop(pluginId): Promise<void>` and `stopAll(): Promise<void>`

- [ ] **Step 1: Write failing worker tests** for handshake success, non-isolated sandbox refusal, timeout, malformed JSON, mismatched ID, oversized line, tool/hook calls, crash restart 1..3, and open circuit after the fourth required start.

- [ ] **Step 2: Verify RED** due missing worker manager.

- [ ] **Step 3: Implement JSONL RPC core.** Generate request IDs with `crypto.randomUUID`, keep a bounded pending map (max 16), validate JSON-RPC envelope/result/error, correlate IDs, apply per-request timers, terminate session on protocol violations, and reverify artifact before every launch.

- [ ] **Step 4: Implement bounded restart.** Unexpected exit marks unhealthy; next call may relaunch until `maxRestarts=3`, then fails with an explicit open-circuit error. Explicit `stop()` does not consume restart budget.

- [ ] **Step 5: Run full CI and review** for request leaks, timer leaks, reentrancy, double resolution, and circuit reset semantics.

---

### Task 4: Durable plugin manager executable lifecycle

**Files:**
- Modify: `packages/plugins/src/manager.ts`
- Modify: `packages/plugins/src/store.ts`
- Modify: `packages/plugins/src/manifest.ts` only if an explicit helper is needed; do not change signed payload semantics.
- Test: `tests/plugin-worker-lifecycle.test.ts`
- Extend: `tests/plugin-transactionality.test.ts`

**Interfaces:**
- Extends `DurablePluginManagerOptions` with `artifacts?: PluginArtifactStore`, `workers?: PluginWorkerManager`, `artifactSourceResolver?: (manifest) => string | undefined`.
- Executable plugin means it declares at least one tool or hook contribution.
- Host-supplied trusted handler resolver remains higher priority; when absent and workers are available, tool/hook handlers proxy to `PluginWorkerManager`.

- [ ] **Step 1: Write failing lifecycle tests** for executable install artifact recording, enabled worker proxy execution, restart artifact re-verification, enable rollback on handshake failure, data-only compatibility, and durability-first disable/uninstall preserving worker ownership when store persistence fails.

- [ ] **Step 2: Verify RED.** Expected failures on missing manager options/artifact metadata/worker integration.

- [ ] **Step 3: Implement install/restart verification.** Install executable artifacts before durable record persistence and verify every durable artifact during `init()` before registering anything.

- [ ] **Step 4: Implement enable proxies transactionally.** Start/handshake before registration, build worker-backed handlers only when trusted host handlers are absent, persist enabled status last, rollback registrations + worker on failure.

- [ ] **Step 5: Implement durability-first disable/uninstall worker shutdown** only after store mutation succeeds.

- [ ] **Step 6: Run full CI and review** for orphan workers/artifacts, restart fail-closed ordering, handler precedence, and deep-clone durability state.

---

### Task 5: CLI artifact resolution and strict worker preflight

**Files:**
- Modify: `apps/cli/src/plugins.ts`
- Modify: `apps/cli/src/index.ts` only if lifecycle shutdown wiring is required.
- Test: `tests/cli-plugin-workers.test.ts`
- Extend: `examples/custom-plugin/README.md`
- Add: `examples/custom-plugin/worker.example.mjs`

**Interfaces:**
- Manifest entrypoint source resolves relative to the manifest JSON directory.
- CLI worker sandbox factory uses `SandboxManager` with `allowUnsafeFallback` omitted/false.
- `HELIX_PLUGIN_NODE_EXECUTABLE` must be absolute when set; default is `process.execPath`.
- Network option is exactly `manifest.permissions.includes('network:egress')` after manifest verification/policy acceptance.

- [ ] **Step 1: Write failing CLI tests** using a signed temporary manifest + worker fixture to prove relative entrypoint resolution, data-only install compatibility, strict isolation refusal when Bubblewrap is unavailable, and network policy derivation without a wildcard bypass.

- [ ] **Step 2: Verify RED.** Expected CLI failures because executable artifact install/preflight is not wired.

- [ ] **Step 3: Implement CLI wiring** for artifact/workspace directories and strict worker factory. Do not add an unsafe environment switch.

- [ ] **Step 4: Update example worker and documentation** with the exact JSONL handshake/tool/hook contract and strict Linux requirement.

- [ ] **Step 5: Run full repository CI**: install, typecheck, build, all tests.

- [ ] **Step 6: Open PR, inspect all changed files, run PR CI, fix any failures, and merge only with fresh expected-head SHA after all gates are green.**

- [ ] **Step 7: Verify post-merge `main` CI** before calling the phase complete.
