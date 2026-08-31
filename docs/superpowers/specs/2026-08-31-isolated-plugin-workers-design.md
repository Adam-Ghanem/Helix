# Isolated Executable Plugin Workers Design

## Goal

Extend Helix's durable signed plugin lifecycle with executable tool and hook contributions without ever loading third-party plugin code into the Helix coordinator process.

## Scope

This phase adds a real artifact boundary, content-addressed artifact storage, strict isolated worker execution, bounded RPC, lifecycle integration, crash recovery, and CLI preflight. Agent and skill contributions remain data-only. Dynamic `import()` of third-party code inside Helix remains forbidden.

## Security invariants

1. Third-party plugin JavaScript is never imported, evaluated, or required inside the Helix coordinator process.
2. Executable plugins run only through an `ExecutableSandbox` whose `isolated` property is `true`. `UnsafeProcessSandbox` is never accepted for plugin execution.
3. The worker executable must be an absolute allowlisted Node executable.
4. Plugin artifacts are single bundled ESM files in v1. Directories, symlinks, devices, sockets, FIFOs, and multi-file packages are rejected.
5. Installation verifies SHA-256 over the exact artifact bytes and stores those bytes under a content-addressed managed artifact path. The manifest `artifactDigest` must match those bytes.
6. Worker startup re-verifies managed artifact bytes before execution. Durable manifest verification alone is insufficient.
7. The plugin artifact is mounted into the sandbox read-only at a fixed `/plugin/worker.mjs` target. Worker scratch state is separate and writable only inside a plugin-specific `/workspace`.
8. Network is disabled by default. It may be enabled only when the manifest requests `network:egress` and installation policy explicitly permits that permission.
9. The worker receives an empty/allowlisted environment. Host secrets and arbitrary process environment variables are never inherited.
10. RPC input/output is JSON only, size bounded, timeout bounded, schema checked, and request-ID correlated. Malformed output fails closed and terminates the worker session.
11. A worker crash never causes unbounded respawn. Restart attempts are capped and transition the worker to an open-circuit state.
12. Enable remains transactional: worker preflight/handshake must succeed before runtime tool/hook proxies become visible. Any registration or persistence failure rolls back newly created worker state and runtime ownership.
13. Disable and uninstall remain durability-first. Durable state changes must succeed before runtime registrations and workers are removed.

## Artifact model

`ManagedPluginManifest.entrypoint` identifies the source artifact supplied to the install flow. For executable contributions, v1 accepts exactly one regular `.mjs` or `.js` file.

A new `PluginArtifactStore` owns a directory separate from lifecycle JSON state:

- `<data>/plugins-artifacts/sha256/<digest>.mjs` — immutable content-addressed artifact.
- `<data>/plugin-workspaces/<plugin-id>/` — plugin-specific scratch directory used as sandbox workspace.

Installation flow:

1. verify manifest signature and policy;
2. resolve the supplied entrypoint path;
3. `lstat` and reject anything except a regular file;
4. read with a maximum artifact size of 8 MiB;
5. compute lowercase SHA-256 and compare to `manifest.artifactDigest` using constant-time comparison on equal-length digest buffers;
6. create managed artifact directories;
7. write bytes to a temporary file with exclusive create semantics;
8. verify the temporary file digest again;
9. atomically rename to the content-addressed path, or accept an already-existing file only after verifying its bytes match the digest;
10. store the normalized managed artifact path in the durable plugin record.

The original source path is never trusted after install.

## Durable record extension

`ManagedPluginRecord` gains optional executable metadata:

```ts
interface ManagedPluginArtifactRecord {
  digest: string;
  path: string;
  size: number;
}
```

`artifact` is present for executable managed plugins and absent for data-only plugins. Restart validation verifies:

- path belongs to the configured artifact store;
- file is regular;
- file digest equals both `record.artifact.digest` and `manifest.artifactDigest`;
- stored size matches actual bytes.

A mismatch causes manager initialization to fail closed before any contribution is exposed.

## Worker protocol

The worker process is persistent for the lifetime of an enabled plugin inside a long-lived Helix host. Communication is newline-delimited JSON over stdin/stdout. Stderr is diagnostic-only and bounded by the sandbox process layer.

Coordinator request:

```json
{"jsonrpc":"2.0","id":"req_...","method":"plugin/handshake","params":{"pluginId":"example","apiVersion":"v1"}}
```

Successful handshake result:

```json
{"jsonrpc":"2.0","id":"req_...","result":{"protocolVersion":"1","pluginId":"example","capabilities":{"tools":true,"hooks":true}}}
```

Tool invocation:

```json
{"jsonrpc":"2.0","id":"req_...","method":"tool/call","params":{"name":"inspect","input":{"text":"hello"}}}
```

Hook invocation:

```json
{"jsonrpc":"2.0","id":"req_...","method":"hook/call","params":{"name":"audit","event":"pre-tool","context":{}}}
```

Responses must contain the matching string `id` and exactly one of `result` or `error`. Error objects contain bounded string `message` and optional JSON `data`.

Protocol limits:

- protocol version: `1`;
- max inbound/outbound line: 1 MiB;
- handshake timeout: 5 seconds;
- tool call timeout: contribution-specific tool host timeout capped at 30 seconds;
- hook timeout: manifest hook timeout capped by the worker session maximum;
- max concurrent requests per worker: 16;
- max restart attempts after unexpected crash: 3 within one worker manager instance;
- no automatic restart after the circuit opens until the plugin is explicitly disabled/enabled or the host restarts.

## Worker bootstrap contract

The plugin bundle owns its own stdin/stdout loop and exports no code into Helix. To keep v1 small and auditable, Helix does not inject an SDK runtime into the plugin process. The bundle must speak the JSONL protocol directly.

The worker command is the configured absolute Node executable plus `/plugin/worker.mjs` as its sole script argument. No shell is used. The coordinator never passes the host artifact path as the script argument.

## Sandbox integration

`PluginWorkerFactory` receives an `IsolatedSandboxFactory` abstraction. Production CLI/host wiring creates a `SandboxManager` configured with:

- plugin-specific scratch workspace;
- allowed command: absolute Node executable only;
- no unsafe fallback;
- network derived from approved `network:egress` permission;
- bounded timeout/output/process/memory limits;
- allowlisted environment containing only protocol metadata explicitly set by Helix;
- one explicit read-only bind mapping the verified managed artifact file to `/plugin/worker.mjs`.

The sandbox must report `isolated === true`; otherwise worker creation fails before process launch.

The sandbox API gains `readOnlyBinds?: Array<{ source: string; target: string }>` on strict Bubblewrap options. Each source must be an absolute regular file or directory explicitly supplied by the trusted host, and each target must be an absolute sandbox path outside `/workspace`, `/home`, `/proc`, `/dev`, and `/tmp`. Bubblewrap plans emit `--ro-bind <source> <target>` for these mappings. The plugin worker uses only the verified artifact file mapping; arbitrary plugin-controlled bind requests do not exist.

Because the existing `ExecutableSandbox.executeRequest()` is one-shot, persistent workers require a focused extension: `spawnSession(request)` returns an isolated child-session abstraction with bounded stdin/stdout framing, cancellation, and close/kill semantics. The existing one-shot API remains backward compatible.

## Worker lifecycle

`PluginWorkerManager` owns sessions by plugin ID.

- `preflight(record)` verifies artifact, launches worker, completes handshake, then closes it. Used by CLI enable where the CLI process is short-lived.
- `start(record)` verifies artifact, launches worker, handshakes, and retains the session.
- `callTool(pluginId, contributionName, input)` dispatches RPC to the live session.
- `callHook(pluginId, contributionName, event, context)` dispatches RPC to the live session.
- `stop(pluginId)` gracefully closes stdin and waits briefly, then kills if needed.
- unexpected close marks the session unhealthy; the next invocation attempts bounded restart until the circuit opens.
- `stopAll()` is available for host shutdown.

No worker is started for plugins with only data-only agent/skill contributions.

## Durable manager integration

`DurablePluginManager` accepts optional executable services:

- `artifacts?: PluginArtifactStore`
- `workers?: PluginWorkerManager`

Install:

- data-only plugin: existing behavior;
- executable tool/hook plugin: `artifacts.install(manifest.entrypoint, manifest.artifactDigest)` before durable record creation; durable record stores managed artifact metadata.

Enable:

1. reverify manifest and managed artifact;
2. if executable contributions exist, start worker and complete handshake;
3. resolve tool/hook handlers as RPC proxies from `PluginWorkerManager` when no trusted host handler resolver is supplied;
4. register contributions;
5. persist enabled record;
6. on any failure, rollback registrations and stop the worker.

Restart:

- verify every durable manifest and every executable artifact before exposure;
- enabled executable plugins start/handshake before contribution re-registration;
- any artifact or worker failure aborts initialization and rolls back all runtime registrations/workers restored in that init attempt.

Disable/uninstall:

- persist durable state first;
- remove runtime registrations;
- stop worker;
- uninstall also removes plugin lifecycle state but leaves content-addressed artifact blobs available for deduplication; garbage collection is outside this phase.

## CLI integration

`helix plugins install <manifest.json>` resolves `entrypoint` relative to the manifest file directory, not the current working directory. The CLI passes this resolved source artifact to the artifact installer while keeping the signed entrypoint string unchanged in the manifest.

`helix plugins enable <id>`:

- requires strict Bubblewrap isolation for plugins with executable tools/hooks;
- verifies the managed artifact;
- runs worker preflight/handshake;
- persists enabled state only when preflight succeeds;
- closes the preflight worker before the CLI exits.

Environment controls:

- `HELIX_PLUGIN_NODE_EXECUTABLE` optional absolute Node path; default `process.execPath`;
- existing trust/policy variables remain authoritative;
- no `HELIX_PLUGIN_UNSAFE_FALLBACK` option is introduced.

## Testing

TDD coverage must include:

- artifact digest match and mismatch;
- symlink/non-regular artifact rejection;
- content-addressed atomic install and existing-blob re-verification;
- restart rejection after managed artifact tampering;
- sandbox read-only bind validation and plan generation;
- sandbox session refuses `isolated=false`;
- worker handshake success, timeout, malformed JSON, mismatched request ID, oversized frame;
- tool and hook RPC proxy execution;
- network defaults off and only enables with approved `network:egress`;
- bounded crash restart and circuit opening;
- enable rollback when worker handshake or runtime registration fails;
- disable/uninstall durability-first semantics with worker ownership preserved on persistence failure;
- CLI relative-entrypoint resolution and strict-isolation preflight behavior;
- data-only plugin compatibility without worker startup;
- all existing repository tests remain green.

## Out of scope

- arbitrary npm dependency installation for plugins;
- multi-file plugin packages;
- Windows/macOS isolation backends;
- WASM plugin ABI;
- secrets brokerage into workers;
- artifact garbage collection;
- hot upgrade of an enabled worker in place;
- remote plugin marketplace/download resolution.
