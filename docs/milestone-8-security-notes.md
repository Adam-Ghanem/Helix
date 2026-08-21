# M8 sandbox security notes

## Reviewed controls

| Threat | Control in M8 | Residual risk |
|---|---|---|
| Shell injection | Local and Docker execution use argv arrays with `shell: false`; no command interpolation | A caller still chooses the executable and arguments, so the policy must be restrictive |
| Path traversal | Canonical existing paths, lexical containment for new paths, denied roots, percent-decoding, and symlink-aware checks | TOCTOU races and filesystem-level containment require container or OS policy |
| Environment leakage | Only allowlisted environment keys are passed; audit records persist key names, never values | The child process can intentionally print an allowed secret; use a secret manager and redaction pipeline for sensitive deployments |
| Unauthorized executable | Exact executable allowlist is checked before launch | PATH resolution and image contents remain deployment responsibilities |
| Orphaned processes | Local process groups are killed on timeout and destroy; Docker exec is killed and containers are force-removed | Host-level child processes outside the process group need OS supervision |
| Resource exhaustion | Local timeouts; Docker memory, CPU, and PID flags; bounded API request body | Local memory/CPU/PID limits are reported as unsupported; Docker daemon policy must be hardened |
| Network access | Local policy defaults to `none` as a declared control; Docker uses `--network none` by default | Local backend cannot provide kernel-level network isolation; use Docker for enforcement |
| Privileged container escape | Docker backend never emits `--privileged`, drops all capabilities, uses `no-new-privileges`, and never mounts the Docker socket | Image vulnerabilities, daemon vulnerabilities, and host configuration still require review |
| Audit bypass | Manager records create/start/exec/stop/destroy, including validation failures; audit persistence is JSONL | Multi-process audit ordering and tamper-evidence require a production event/audit service |

## Deployment rule

`LocalSandbox` is a real process-control and policy backend, but it is **not a container or kernel isolation boundary**. Use `DockerSandbox` for production isolation only after reviewing the Docker daemon, image provenance, user mapping, seccomp/AppArmor configuration, workspace permissions, and network policy.

The M8 implementation deliberately does not claim that a local timeout is equivalent to a cgroup limit, that a workspace path is equivalent to a mount namespace, or that a declared network mode is equivalent to host-level packet filtering. These distinctions are returned in `SandboxResult.limitations` and documented in the public capability boundaries.
