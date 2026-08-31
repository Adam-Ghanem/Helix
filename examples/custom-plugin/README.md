# Governed plugin example

Helix managed plugins are manifest-first and fail closed. They support durable lifecycle state, Ed25519 manifest signatures, explicit install policy, namespaced contributions, data-only skills/agents, and strictly isolated executable tool/hook workers.

Helix never dynamically imports, evaluates, or requires third-party plugin code in the coordinator process. Executable tool and hook contributions run only through the isolated worker RPC boundary.

## Manifest lifecycle

1. Bundle executable plugin code into exactly one regular `.js` or `.mjs` file (maximum 8 MiB).
2. Compute SHA-256 over the exact artifact bytes and put the lowercase hex digest in `artifactDigest`.
3. Set `entrypoint` to the artifact path relative to the manifest JSON file.
4. Set a stable `signerKeyId` that maps to a trusted Ed25519 public key.
5. Sign Helix's canonical managed-plugin signing payload with the corresponding Ed25519 private key and store the Base64 signature in `signature`.
6. Configure explicit trust and install policy in the Helix process.
7. Install the manifest. For executable plugins, Helix resolves the entrypoint relative to the manifest, verifies the exact digest, rejects symlinks/non-regular files, and stores immutable content-addressed bytes under `${HELIX_DATA_DIR}/plugins-artifacts/sha256`.
8. Enable the plugin. Helix re-verifies manifest policy and artifact bytes, requires strict Linux Bubblewrap isolation, performs a worker handshake, and persists `enabled` only after preflight succeeds.
9. Disable or remove the plugin to withdraw its owned contributions.

The example manifest uses placeholders and is not directly installable until its digest and signature are replaced with real values.

## CLI configuration

The CLI uses these environment variables:

- `HELIX_PLUGIN_TRUST_KEYS`: JSON object mapping signer key IDs to PEM-encoded Ed25519 public keys.
- `HELIX_PLUGIN_ALLOWED_PERMISSIONS`: comma-separated permission allowlist.
- `HELIX_PLUGIN_ALLOWED_CAPABILITIES`: comma-separated capability allowlist.
- `HELIX_PLUGIN_ALLOWED_API_VERSIONS`: comma-separated managed-plugin API version allowlist.
- `HELIX_PLUGIN_NODE_EXECUTABLE`: optional absolute Node executable path; defaults to the Helix process Node executable.

No signer, API version, capability, permission, network access, or unsafe host fallback is allowed implicitly. There is intentionally no plugin unsafe-fallback environment switch.

Example policy for a data-only skill plugin:

```sh
export HELIX_PLUGIN_TRUST_KEYS='{"publisher-main":"-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----"}'
export HELIX_PLUGIN_ALLOWED_PERMISSIONS='skill:register'
export HELIX_PLUGIN_ALLOWED_CAPABILITIES='analysis'
export HELIX_PLUGIN_ALLOWED_API_VERSIONS='v1'
```

Then manage lifecycle state with:

```sh
helix plugins install examples/custom-plugin/manifest.example.json --json
helix plugins inspect reviewer --json
helix plugins enable reviewer --json
helix plugins list --json
helix plugins disable reviewer --json
helix plugins remove reviewer --json
```

## Contribution boundaries

Managed contributions are always namespaced:

- tools: `plugin:<pluginId>:tool:<name>`
- hooks: `plugin:<pluginId>:hook:<name>`
- agents: `plugin:<pluginId>:agent:<name>`
- skills: `plugin:<pluginId>:skill:<name>`

Skills and agents are data-only and start no worker. Tools and hooks are executable and use the worker boundary unless a trusted host-supplied handler explicitly takes precedence.

## Isolation and artifact boundary

Executable plugins require Linux Bubblewrap. Helix binds only the re-verified managed artifact read-only at `/plugin/worker.mjs`; plugin scratch state is writable only in a plugin-specific `/workspace`. Runtime paths are read-only, the environment is allowlisted, output and request sizes are bounded, and no unsafe process fallback is accepted for plugin execution.

Network is disabled by default. It is enabled only when the signed manifest contains `network:egress` and the installation policy explicitly allows that permission.

Helix verifies managed artifact bytes again before every worker launch or restart. Tampering after installation fails closed.

## JSONL worker protocol v1

`worker.example.mjs` shows the minimal protocol. The worker reads one JSON-RPC 2.0 object per stdin line and writes exactly one correlated response per stdout line. Frames are capped at 1 MiB and the coordinator bounds pending requests, timeouts, and crash restarts.

Handshake request:

```json
{"jsonrpc":"2.0","id":"<request-id>","method":"plugin/handshake","params":{"pluginId":"reviewer","apiVersion":"v1"}}
```

Handshake response:

```json
{"jsonrpc":"2.0","id":"<request-id>","result":{"protocolVersion":"1","pluginId":"reviewer","capabilities":{"tools":true,"hooks":true}}}
```

Tool call:

```json
{"jsonrpc":"2.0","id":"<request-id>","method":"tool/call","params":{"name":"inspect","input":{"text":"hello"}}}
```

Hook call:

```json
{"jsonrpc":"2.0","id":"<request-id>","method":"hook/call","params":{"name":"audit","event":"pre-tool","context":{}}}
```

Responses must use the matching string `id` and contain exactly one of `result` or `error`. Protocol violations, malformed JSON, unknown response IDs, oversized frames, and request timeouts terminate the worker session. Unexpected crashes permit at most three lazy restarts per manager instance before the circuit opens.

The worker receives only protocol metadata such as `HELIX_PLUGIN_ID` and `HELIX_PLUGIN_PROTOCOL_VERSION`; arbitrary host secrets are not inherited.