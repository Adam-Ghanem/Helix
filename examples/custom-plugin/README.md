# Governed plugin example

Helix managed plugins are manifest-first and fail closed. This phase supports durable lifecycle state, Ed25519 manifest signatures, explicit install policy, namespaced contributions, and data-only skills.

Helix does **not** dynamically import or execute the `entrypoint` from a third-party plugin in the coordinator process. The `entrypoint` field is signed metadata in this phase. Executable plugin code belongs in the follow-up isolated-worker/RPC runtime.

## Manifest lifecycle

1. Build the manifest and compute a SHA-256 value for the artifact/package descriptor you intend to identify.
2. Put that hex digest in `artifactDigest`.
3. Set a stable `signerKeyId` that maps to a trusted Ed25519 public key.
4. Sign Helix's canonical managed-plugin signing payload with the corresponding Ed25519 private key and store the Base64 signature in `signature`.
5. Configure explicit trust and install policy in the Helix process.
6. Install the manifest. Installation stores it as `installed` but exposes no contributions.
7. Enable the plugin. Helix re-verifies the signature and policy before registering contributions.
8. Disable or remove the plugin to withdraw its owned contributions.

The example manifest uses placeholders and is not directly installable until its digest and signature are replaced with real values.

## CLI configuration

The CLI reads plugin state under `${HELIX_DATA_DIR}/plugins` and uses these environment variables:

- `HELIX_PLUGIN_TRUST_KEYS`: JSON object mapping signer key IDs to PEM-encoded Ed25519 public keys.
- `HELIX_PLUGIN_ALLOWED_PERMISSIONS`: comma-separated permission allowlist.
- `HELIX_PLUGIN_ALLOWED_CAPABILITIES`: comma-separated capability allowlist.
- `HELIX_PLUGIN_ALLOWED_API_VERSIONS`: comma-separated managed-plugin API version allowlist.

No permission, capability, API version, or signer is allowed implicitly.

Example policy for the data-only skill manifest:

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

Skills contain instructions and requirements only. They do not contain executable code.

Tool and hook contributions require a trusted host-provided handler resolver. The standalone CLI intentionally does not resolve arbitrary third-party handlers, so enabling a tool/hook plugin through the CLI alone fails closed instead of executing an entrypoint.

## Artifact integrity boundary

`artifactDigest` is part of the signed manifest and protects the declared artifact identity from undetected manifest tampering. This phase does not open the artifact or execute it, so it does not claim runtime verification of executable artifact bytes.

The next plugin phase will bind the signed digest to an isolated executable artifact and run it behind a strict sandboxed worker/RPC boundary.