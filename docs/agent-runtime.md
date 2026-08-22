# Agent Runtime Reference

## Purpose

`AgentRuntime` is Helix's bounded per-agent execution layer. It is a composition over the existing scheduler, worker seam, provider boundary, policy engine, sandbox manager, MCP authorization, memory ACLs, learning engine, durable events, and M16 traces. It is not a general-purpose shell agent and it does not replace any existing authority.

## Runtime contract

```ts
const result = await runtime.runAgent(agentId, { title, description }, {
  goal,
  sessionId,
  swarmId,
  config: {
    maxIterations,
    maxToolCalls,
    maxExecutionTimeMs,
    maxProviderCalls,
    maxTokens,
    maxCostUsd,
    maxMemoryRecalls,
    repeatedToolCallLimit,
    noMemory,
    signal,
  },
});
```

The returned `AgentExecutionResult` includes execution, task, and agent IDs; status; final output; structured tool-call records; iteration count; duration; provider/model; usage and cost metadata when available; memory recalled/created; errors; trace ID; and a budget status snapshot.

Statuses are `completed`, `failed`, `cancelled`, `timeout`, `budget_exceeded`, and `policy_denied`. Every execution is bounded even when the provider repeatedly requests the same action or returns malformed data.

## Decision contract

Providers may implement the existing optional structured decision capability:

```ts
{ decision: { type: 'tool_call', toolName, arguments }, usage? }
{ decision: { type: 'final', content }, usage? }
```

M17 validates the response shape, treats all model content as untrusted, and never maps model text directly to a process command. Deterministic local execution is the default and is suitable for tests, demonstrations, and offline development. The OpenAI-compatible adapter remains explicit opt-in and must provide URL, key, and model configuration before any external request occurs.

## Tool contract

Every registered tool has a unique name, description, input schema, risk, category, permissions, timeout, executor, and optional metadata. Categories are `READ`, `WRITE`, `EXECUTE`, `NETWORK`, and `ADMIN`.

The execution sequence is:

```text
model decision
  → tool lookup
  → schema validation
  → registered agent identity
  → existing policy/RBAC decision
  → budget and timeout checks
  → MCP/security boundary where applicable
  → SandboxManager for executable operations
  → sanitized result
  → audit/event/trace evidence
```

The runtime rejects unknown tools, malformed arguments, denied permissions, policy denials, path traversal, shell injection, unauthorized network intent, environment leakage, and attempts to change actor identity. Built-in filesystem tools are workspace-scoped. The only command execution route is an explicitly registered tool that delegates to `SandboxManager`; AgentRuntime does not import `child_process` or interpolate shell strings.

## Context and persona

The runtime uses `AgentRegistry` definitions for role, capabilities, specialization, and system guidance. A shared runtime handles all profiles; there are no separate hardcoded implementations for the 100 built-in agents. Context contains bounded task metadata, role guidance, the available tool inventory, and advisory M10 memory recall. Task content and memory entries are explicitly treated as untrusted data.

## Memory and learning

Pre-execution recall uses the host's existing M10 memory boundary and can be disabled with `noMemory`. Post-execution learning records sanitized success/failure evidence, duration, quality, task type, capabilities, trace ID, tool count, iterations, and optional session/swarm IDs. Namespace selection remains the responsibility of the existing memory/learning layer, using `agent:<id>`, `task:<id>`, `session:<id>`, or `swarm:<id>` where appropriate. Credentials, raw authorization headers, secrets, sandbox environment values, and untrusted executable payloads are not persisted.

## Budgets and cancellation

Budget checks happen before provider calls, tool calls, memory recall, and iteration work. Limits cover wall-clock duration, iterations, tool calls, provider calls, tokens, estimated cost, memory recalls, repeated identical calls, and policy-denial termination. Warning and exceeded events are emitted through M16's typed event path.

An `AbortSignal` flows from `HelixRuntime.cancelAgentExecution()` through AgentRuntime, provider calls, ToolExecutor, and sandbox callbacks. `runAgent()` owns a scheduler lease and releases it in `finally`, restoring the registry agent to idle. This prevents orphaned leases and is the local cancellation guarantee.

## Trace and event reference

Agent traces are built from durable event evidence. Important stages include:

| Stage | Evidence |
|---|---|
| `agent.created` | agent role and execution identity |
| `agent.context.created` | bounded tool inventory and memory count |
| `agent.memory.recalled` | recall count only |
| `agent.provider.started/completed` | provider, model, iteration, usage |
| `agent.decision.created` | decision type, never private chain-of-thought |
| `agent.tool.requested/authorized/started/completed` | tool identity, risk, authorization, duration |
| `agent.tool.failed` / `agent.policy.denied` | normalized reason |
| `agent.budget.warning/exceeded` | bounded resource metadata |
| `agent.evaluation.completed` | status and observable counts |
| `agent.learning.updated` | number of persisted learned entries |
| `agent.completed/failed/cancelled/timeout` | terminal outcome |

Tool arguments and results are recursively sanitized. Dashboard and MCP inspection use the same redacted runtime evidence.

## API, CLI, MCP, and dashboard

The API routes are `POST /api/v1/agents/:id/run`, `GET /api/v1/agents/:id/executions`, `GET /api/v1/executions/:id`, `GET /api/v1/executions/:id/trace`, and `POST /api/v1/executions/:id/cancel`. The CLI entry point is:

```bash
helix agent run <agent-id> "<task>" --provider deterministic-local --max-iterations 8 --timeout 60000 --json
```

Inspection commands include `helix agent executions <agent-id>`, `helix agent execution <execution-id>`, and `helix agent cancel <execution-id>`. MCP provides `agent.run`, `agent.cancel`, `agent.execution`, `agent.executions`, and `agent.tool-history`; execution is an `EXECUTE` risk operation and read-only actors cannot call it. The dashboard presents agent detail and execution timeline views over live API data.

## Deterministic, external, and sandbox modes

| Mode | Behavior | External calls |
|---|---|---:|
| Deterministic local | Repeatable provider decisions, local policy, local memory, local sandbox | No |
| OpenAI-compatible | Explicit configured HTTP provider with timeout, response validation, and usage accounting | Yes, only when configured |
| Docker sandbox | Existing DockerSandbox with container controls and resource limits | Docker daemon only |
| Local sandbox | Existing LocalSandbox with argv, path, environment, timeout, and process cleanup | No external service |

The deterministic benchmark and test suite must not require an API key. Provider availability and Docker availability must be reported separately from test status.

## Limitations

M17 is a bounded runtime layer, not a guarantee of correct reasoning. Deterministic outputs are simulations and must not be described as real LLM intelligence. Local JSONL/SQLite persistence is not a replicated control plane. Local sandbox controls are not kernel-level isolation. The current adapter does not claim distributed consensus, Byzantine fault tolerance, unrestricted network access, or autonomous authority to modify trust, ACLs, or policy. Production deployments still require reviewed secret management, TLS, provider quotas, multi-host state, sandbox hardening, rate-limit operations, and independent security review.
