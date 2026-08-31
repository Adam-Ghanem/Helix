# Durable Plugin Runtime Design

## Goal

Upgrade Helix's existing in-memory `PluginRegistry` into a durable, governed plugin/skill lifecycle that provides Ruflo-class extensibility without allowing arbitrary third-party code to execute inside the Helix process.

## Scope

This phase builds a manifest-first lifecycle foundation. It supports install, inspect, enable, disable, uninstall, restart-safe persistence, cryptographic trust, permission enforcement, namespaced contributions, and data-only skills. It does **not** dynamically `import()` third-party JavaScript. Executable plugin workers are a later isolation phase.

## Existing boundaries to preserve

- `PluginRegistry` remains available for compatibility.
- `ToolRegistry`, `HookEngine`, and `AgentRegistry` remain the authoritative runtime registries.
- Existing built-in and MCP/provider registration behavior must not change.
- The default security posture stays fail-closed.

## Manifest model

A managed plugin uses a v1 manifest:

- `id`: stable lowercase identifier matching `^[a-z0-9][a-z0-9._-]{1,63}$`.
- `name`, `version`, `apiVersion`.
- `entrypoint`: metadata only in this phase; it is never imported or executed.
- `permissions`: requested plugin permissions.
- `capabilities`: declared high-level capabilities.
- `artifactDigest`: SHA-256 hex digest of the installed artifact payload or package descriptor.
- `signerKeyId`: trust-store key identifier.
- `signature`: Ed25519 signature over the canonical signing payload.
- `contributions`: optional arrays for `tools`, `hooks`, `agents`, and `skills`.

The canonical signing payload includes all security-relevant manifest fields plus `artifactDigest`, with deterministic key ordering and sorted permission/capability arrays. Signature verification uses Node `crypto.verify(null, payload, publicKey, signature)` with Ed25519 public keys.

## Trust and policy

`PluginTrustStore` maps `signerKeyId` to trusted Ed25519 public keys.

`PluginInstallPolicy` defines:

- allowed permissions,
- allowed capabilities,
- allowed API versions,
- maximum contribution counts,
- whether unsigned legacy manifests are accepted by the legacy `PluginRegistry` only.

Managed installation rejects:

- unknown signer,
- invalid signature,
- malformed/non-SHA256 artifact digest,
- unsupported API version,
- permission or capability escalation,
- duplicate plugin IDs,
- duplicate contribution names inside a plugin,
- invalid contribution definitions.

## Durable state

`DurablePluginStore` persists one atomic JSON document under a configurable data directory. State contains schema version and plugin records.

A managed plugin record stores:

- normalized manifest,
- lifecycle status: `installed | enabled | disabled`,
- install/update timestamps,
- verified signer key ID,
- manifest digest,
- registered runtime contribution IDs/names where needed for deterministic cleanup.

Writes use temp-file + rename. Reads validate schema/version and fail closed on malformed state. Lifecycle operations are serialized to prevent conflicting writes.

## Runtime manager

`DurablePluginManager` coordinates store + trust + policy + runtime registries.

Public lifecycle:

- `init()` restores durable state and re-registers only enabled plugins.
- `install(manifest)` verifies trust/policy and stores status `installed`; install alone does not expose runtime contributions.
- `enable(id)` registers all contributions atomically; if any registration fails, all registrations from that enable attempt are rolled back and the durable status remains unchanged.
- `disable(id)` removes all owned runtime contributions and stores status `disabled`.
- `uninstall(id)` disables first, then removes durable state.
- `get(id)` and `list()` return deep-cloned public records.
- `resolveSkill(pluginId, skillName)` returns an enabled data-only skill only.

## Namespacing and ownership

Plugins never register arbitrary global names.

Canonical runtime names:

- tool: `plugin:<pluginId>:tool:<name>`
- hook: `plugin:<pluginId>:hook:<name>`
- agent name: `plugin:<pluginId>:agent:<name>`
- skill: `plugin:<pluginId>:skill:<name>`

This prevents overwrite of built-ins and cross-plugin collisions.

The manager stores ownership metadata privately and performs deterministic cleanup during disable/uninstall/restart reconciliation.

## Permission mapping

Registration requires manifest permissions:

- tools -> `tool:register`
- hooks -> `hook:register`
- agents -> `agent:register`
- skills -> `skill:register`

Invocation/use also remains governed:

- plugin tool definitions can declare runtime permissions; each required runtime permission must be present in the plugin manifest.
- plugin skills declare `requiredTools` and `requiredCapabilities`; required plugin-owned tools must exist and required external tool names are data references only, not direct execution grants.
- disabled plugins cannot be resolved or invoked through manager-owned surfaces.

No plugin can grant itself `filesystem:read`, `filesystem:write`, `network:egress`, `secret:read`, or other permissions that were not approved at installation.

## Contribution types

### Tool contribution

Data plus a host-provided handler resolver. The manifest defines name, description, risk, permissions, and input schema. The manager accepts a `PluginHandlerResolver` supplied by the trusted host. The manifest does not contain executable code.

### Hook contribution

Data plus a host-provided hook handler resolver. The manifest defines events, priority, criticality, timeout, and optional always-run flag.

### Agent contribution

Data-only profile template: name, role, capabilities, permissions, optional model/provider. Runtime registration returns a concrete `AgentProfile`; the manager records its generated ID for removal.

### Skill contribution

Data-only capability: name, description, instructions, optional required tools/capabilities. Skills are returned only when the owning plugin is enabled.

## Failure semantics

- Verification and policy errors never mutate durable state.
- Enable is transactional from the caller's perspective: partial runtime registrations are rolled back.
- Disable is idempotent for already-disabled/installed plugins.
- Uninstall of an unknown plugin fails clearly.
- Restart reconciliation trusts durable state only after state validation and re-runs runtime registration checks.
- Host handler resolution failure blocks enable and is rolled back.

## CLI

Add commands:

- `helix plugins list [--json]`
- `helix plugins inspect <id> [--json]`
- `helix plugins install <manifest.json> [--json]`
- `helix plugins enable <id> [--json]`
- `helix plugins disable <id> [--json]`
- `helix plugins remove <id> [--json]`

CLI state directory defaults to `HELIX_DATA_DIR/plugins`. Trust keys are loaded from `HELIX_PLUGIN_TRUST_KEYS`, a JSON object mapping key IDs to PEM public keys. Allowed permissions/capabilities are explicit environment-backed policy inputs; no wildcard permission is inferred.

For this phase, CLI install supports manifests whose contributions are data-only or have no local executable tool/hook handlers. If a contribution requires a handler that the CLI host cannot resolve, enable fails closed.

## Testing

TDD coverage must include:

- valid Ed25519 installation;
- tampered manifest/signature rejection;
- unknown signer rejection;
- permission/capability escalation rejection;
- restart persistence;
- enable/disable/uninstall lifecycle;
- namespace isolation and collision prevention;
- transactional rollback on partial enable failure;
- skill resolution only while enabled;
- tool/hook/agent registration and cleanup;
- CLI list/inspect/install/enable/disable/remove behavior;
- compatibility tests for legacy `PluginRegistry`.

Full repository typecheck, build, unit/integration tests, PR CI, and post-merge main CI are required before calling the phase complete.

## Follow-up phase

Build isolated executable plugin workers over this lifecycle using process/RPC boundaries and the existing strict sandbox. Third-party code must never be loaded into the Helix coordinator process.