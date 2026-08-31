# Durable Plugin Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a restart-safe, signed, least-privilege plugin/skill lifecycle on top of Helix's existing registries without executing third-party plugin code in-process.

**Architecture:** Extend `packages/plugins` with focused manifest/trust/store/manager modules. The manager verifies Ed25519 signatures and policy, persists lifecycle state atomically, and registers namespaced contributions into the existing tool/hook/agent registries. Skills are data-only. CLI commands manage the durable state and fail closed when handlers or trust are unavailable.

**Tech Stack:** TypeScript, Node.js `crypto`, `fs/promises`, existing Helix ToolRegistry/HookEngine/AgentRegistry, node:test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-31-durable-plugin-runtime-design.md`

## Global Constraints

- No dynamic `import()` or execution of third-party plugin JavaScript in this phase.
- Managed plugins require Ed25519 signature verification and SHA-256 artifact digest validation.
- Default deny for permissions, capabilities, and signer trust.
- Runtime names are namespaced as `plugin:<pluginId>:<kind>:<name>`.
- Enable must roll back partial registrations on failure.
- Existing `PluginRegistry` behavior remains compatible.
- Full typecheck, build, tests, PR CI, and post-merge main CI are required.

---

### Task 1: Signed manifest and durable store

**Files:**
- Create: `packages/plugins/src/manifest.ts`
- Create: `packages/plugins/src/store.ts`
- Modify: `packages/plugins/src/index.ts`
- Test: `tests/plugin-runtime.test.ts`

**Interfaces:**
- Produces `ManagedPluginManifest`, `PluginContributionSet`, `PluginTrustStore`, `PluginInstallPolicy`, `verifyManagedManifest()`, `DurablePluginStore`, `ManagedPluginRecord`.

- [ ] **Step 1: Write failing tests** for valid Ed25519 verification, tampering, unknown signer, permission escalation, and restart-safe store persistence.
- [ ] **Step 2: Run `pnpm test tests/plugin-runtime.test.ts`** and verify failures are missing APIs/behavior.
- [ ] **Step 3: Implement canonical signing payload, Ed25519 verification, policy validation, normalization, atomic JSON persistence, and schema validation.**
- [ ] **Step 4: Re-run focused test and make it Green.**
- [ ] **Step 5: Commit `feat: add signed durable plugin state`.**

Core signatures:

```ts
export interface ManagedPluginManifest extends PluginManifest {
  id: string;
  apiVersion: string;
  artifactDigest: string;
  signerKeyId: string;
  signature: string;
  contributions?: PluginContributionSet;
}

export interface PluginTrustStore {
  keys: Record<string, string>;
}

export interface PluginInstallPolicy extends PluginPolicy {
  allowedApiVersions: string[];
  maxContributionsPerKind?: number;
}

export function verifyManagedManifest(
  manifest: ManagedPluginManifest,
  trust: PluginTrustStore,
  policy: PluginInstallPolicy,
): { manifest: ManagedPluginManifest; manifestDigest: string };
```

### Task 2: Transactional runtime lifecycle and skills

**Files:**
- Create: `packages/plugins/src/manager.ts`
- Modify: `packages/plugins/src/index.ts`
- Modify: `packages/tools/src/index.ts` only if deterministic unregister support is missing.
- Test: `tests/plugin-runtime.test.ts`

**Interfaces:**
- Produces `DurablePluginManager`, `PluginHandlerResolver`, `PluginSkill`, lifecycle methods `init/install/enable/disable/uninstall/get/list/resolveSkill`.

- [ ] **Step 1: Add RED tests** for namespace isolation, tool/hook/agent registration, skill resolution, disable cleanup, uninstall, restart rehydration, and rollback when the second contribution fails.
- [ ] **Step 2: Run focused test and verify RED.**
- [ ] **Step 3: Implement manager registration mapping and cleanup ledger.** Tool cleanup uses a narrow `ToolRegistry.unregister(name): boolean` addition if needed; hooks already expose `unregister`, agents expose `remove`.
- [ ] **Step 4: Enforce contribution registration permissions and runtime permission subset checks.**
- [ ] **Step 5: Run focused test Green and full plugin/security parity tests Green.**
- [ ] **Step 6: Commit `feat: add durable plugin lifecycle manager`.**

Manager constructor:

```ts
new DurablePluginManager({
  store,
  trust,
  policy,
  tools,
  hooks,
  agents,
  handlers?: {
    tool(pluginId, contribution): Promise<ToolDefinition['handler'] | undefined>;
    hook(pluginId, contribution): Promise<HookDefinition['handler'] | undefined>;
  },
});
```

### Task 3: CLI plugin management

**Files:**
- Modify: `apps/cli/src/index.ts`
- Test: `tests/cli-plugins.test.ts`

**Interfaces:**
- Commands: `helix plugins list|inspect|install|enable|disable|remove`.
- Env: `HELIX_DATA_DIR`, `HELIX_PLUGIN_TRUST_KEYS`, `HELIX_PLUGIN_ALLOWED_PERMISSIONS`, `HELIX_PLUGIN_ALLOWED_CAPABILITIES`.

- [ ] **Step 1: Add RED CLI tests** for help text, JSON list/inspect, signed manifest install, enable/disable/remove, malformed trust JSON, and denied permission.
- [ ] **Step 2: Run focused CLI test and verify RED.**
- [ ] **Step 3: Implement CLI parser + manager factory with explicit env policy.**
- [ ] **Step 4: Run focused CLI tests Green.**
- [ ] **Step 5: Commit `feat: add plugin lifecycle CLI`.**

### Task 4: Example, docs, and security regression gates

**Files:**
- Create: `examples/custom-plugin/README.md`
- Create: `examples/custom-plugin/manifest.example.json`
- Modify: `docs/ruflo-parity-roadmap.md`
- Test: `tests/security-parity.test.ts`

- [ ] **Step 1: Add security regression assertions** that legacy registry still enforces least privilege and managed runtime rejects unsigned/tampered content.
- [ ] **Step 2: Document the manifest-first model and explicitly state that executable third-party code is not loaded in-process.**
- [ ] **Step 3: Update parity roadmap current state/next step.**
- [ ] **Step 4: Run security + plugin tests Green.**
- [ ] **Step 5: Commit `docs: document governed plugin runtime`.**

### Task 5: Full verification, PR review, merge

**Files:** all changed files.

- [ ] **Step 1: Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm typecheck`, `pnpm build`, and `pnpm test`.**
- [ ] **Step 2: Review branch diff for signature canonicalization, permission bypass, path/trust parsing, rollback correctness, and accidental dynamic imports.**
- [ ] **Step 3: Open PR with exact verification evidence.**
- [ ] **Step 4: Require PR CI Green on the final head SHA.**
- [ ] **Step 5: Squash merge with expected head SHA.**
- [ ] **Step 6: Require post-merge `main` CI Green before declaring complete.**
