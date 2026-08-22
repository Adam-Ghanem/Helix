# M17 — Real Agent Runtime and Tool-Calling Loop

## Scope

M17 adds the missing agent-execution layer to Helix. A single `AgentRuntime` receives a task, builds a bounded context from the existing `AgentRegistry` and M10 memory, asks the configured provider for a validated structured decision, executes approved tools through policy, appends sanitized results, and repeats until it produces a final result or reaches a terminal bound.

The runtime is deterministic when `deterministic-local` is configured. It does not claim that a deterministic provider is equivalent to an intelligent language model. The existing provider interface remains authoritative; M17 adds the optional structured `executeAgent` capability rather than creating a second provider abstraction.

## Execution path

```text
Goal / task
  → existing planner, router, swarm, scheduler, and worker seam
  → AgentRuntime
  → role/persona context + bounded M10 memory recall
  → existing ModelProvider / structured decision validation
  → ToolExecutor
      → agent permissions
      → existing PolicyEngine / authorization
      → tool schema and budget checks
      → SandboxManager for executable operations
      → sanitized result and audit event
  → next bounded iteration or final result
  → evidence evaluation
  → existing M9/M10 learning persistence
```

`HelixRuntime.runAgent()` acquires an existing `LeaseScheduler` lease, marks the selected registry agent busy, invokes the AgentRuntime, emits the standard execution lifecycle, releases the lease in `finally`, and restores the agent to idle. No second scheduler, worker pool, memory backend, policy engine, or task execution path is introduced.

## Structured provider decisions

Every provider response is untrusted input and is validated before interpretation. The accepted decision forms are:

```ts
{ type: 'tool_call', toolName: string, arguments: Record<string, unknown> }
{ type: 'final', content: string }
```

The deterministic provider implements repeatable workflows such as project inspection: list files, read a file, then produce a final answer. The HTTP/OpenAI-compatible provider accepts the same structured decision shape, applies a bounded timeout, validates the response, records usage metadata, and normalizes provider failures. External calls occur only when the provider is explicitly configured.

## Unified tools and security

`AgentToolRegistry` stores tool definitions with name, description, input schema, category, risk, permissions, timeout, metadata, and an executor. Built-in tools include bounded memory search, workspace-scoped filesystem listing/reading, and governed sandbox execution. Tool calls never receive a caller-controlled actor or permission set; the runtime supplies the registered agent identity.

Before each call, M17 validates the tool name and arguments, authenticates the actor through the host boundary, checks agent permissions and the existing policy engine, checks budgets, invokes the executor with an `AbortSignal`, and records sanitized evidence. Default-deny remains authoritative. Model output cannot invoke arbitrary shell, change federation trust, alter memory ACLs, or escape the workspace. Executable operations must be exposed through `SandboxManager`; AgentRuntime has no direct `child_process` access.

Prompt/tool injection, memory poisoning, privilege escalation, malicious arguments, path traversal, shell injection, environment leakage, and repeated-loop attacks are treated as untrusted-data or policy failures. Secret-like keys and values are redacted from tool arguments, results, errors, events, traces, learning metadata, and dashboard output.

## Bounded loop and budgets

The runtime enforces wall-clock time, iterations, tool calls, provider calls, estimated tokens, estimated cost, memory recall count, repeated identical calls, and policy-denial termination. Budget checks occur before the relevant operation. Warning and exceeded events are emitted through the M16 event path. Terminal statuses are `completed`, `failed`, `cancelled`, `timeout`, `budget_exceeded`, and `policy_denied`.

Cancellation is propagated through the runtime abort signal, provider request, tool executor, and sandbox callback. `HelixRuntime.cancelAgentExecution()` addresses active agent executions by ID and does not leave an owned scheduler lease behind.

## Memory, learning, and traces

Context construction performs bounded advisory recall using the existing M10 ACL/provenance/sanitization boundary. Successful and failed outcomes are sent to the existing learning callback with task, agent, optional session/swarm, trace, duration, quality, and bounded tool metadata. M17 never stores credentials, raw authorization headers, executable payloads, or sensitive sandbox environment values.

M16 trace/event surfaces receive the stages `agent.created`, `agent.context.created`, `agent.memory.recalled`, `agent.provider.started`, `agent.provider.completed`, `agent.decision.created`, `agent.tool.requested`, `agent.tool.authorized`, `agent.tool.started`, `agent.tool.completed`, `agent.tool.failed`, `agent.policy.denied`, `agent.iteration.completed`, `agent.budget.warning`, `agent.budget.exceeded`, `agent.evaluation.completed`, `agent.learning.updated`, and terminal agent events. Tool records include tool-call ID, iteration, agent/task/execution IDs, duration, risk, authorization result, status, and sanitized evidence.

## Surfaces

The API exposes:

| Route | Purpose |
|---|---|
| `POST /api/v1/agents/:id/run` | Start a bounded agent execution |
| `GET /api/v1/agents/:id/executions` | List an agent's execution history |
| `GET /api/v1/executions/:id` | Inspect a structured agent result |
| `GET /api/v1/executions/:id/trace` | Inspect the execution trace |
| `POST /api/v1/executions/:id/cancel` | Cancel an active execution |

The CLI exposes `helix agent run <agent-id> "<task>"` with model/provider, iteration, timeout, and no-memory options, together with agent execution list/inspect/cancel commands. MCP adds governed `agent.run`, `agent.cancel`, `agent.execution`, `agent.executions`, and `agent.tool-history` actions. Agent execution is classified as `EXECUTE`; read-only actors cannot invoke it. Inspection remains subject to the shared MCP authorization, rate-limit, audit, and redaction boundary.

The M16 dashboard now includes selectable agent detail and execution timeline views showing role, specialization, capabilities, health, reputation, current status, execution history, tool calls, provider/model, latency, failures, memory counts, policy denials, and trace stages. It is read-only and calls live API endpoints; it contains no production fixture data.

## Verification and limitations

The M17 focused suite contains 31 scenarios covering deterministic completion, single and multiple tool calls, iteration/tool/time budgets, cancellation, provider failure and timeout classification, policy and sandbox denial, schema validation, repeated-call detection, memory recall, learning persistence, trace evidence, redaction, permission escalation, path traversal, shell injection, prompt/memory poisoning, environment protection, 100-agent and 1,000-task deterministic simulations, scheduler integration, swarm context, federation preservation, MCP authorization, no direct process access, and no external calls in deterministic tests.

The definitive final-gate benchmark run (`pnpm agent-runtime:benchmark`) used `deterministic-local` with no external calls. Context/loop p50/p95/p99 was **0.080541/0.368702/1.121755 ms**; provider decision was **0.074073/0.173155/0.365576 ms**; tool authorization/execution was **0.165054/0.442729/0.649418 ms**; complete loop was **0.080541/0.368702/1.121755 ms**; the multi-tool workflow completed in **0.405989 ms** with one tool call; 100/100 agent tasks completed at **6,576.51/s**; and 1,000/1,000 tasks completed in **82.653219 ms** at **12,098.74/s**. The final demo (`pnpm agent-runtime:demo`) used 100 agents, formed one real local M13 pipeline swarm with one member, performed filesystem list/read inspection, executed a governed local sandbox command, recorded one intentional tool failure and a separate successful bounded recovery, denied one filesystem write, ran tester/reviewer stages, learned 31 memories, emitted 116 durable events and seven traces, and made no external provider call.

The benchmark and demo use the deterministic provider and local sandbox unless explicitly configured otherwise. The 100-agent and 1,000-task measurements are deterministic local workloads, not production capacity promises. The local sandbox cannot provide kernel-level isolation or cgroup enforcement; Docker availability must be checked separately. M17 does not claim real LLM intelligence when using the deterministic provider, replicated control-plane state, distributed consensus, Byzantine fault tolerance, or unrestricted autonomous execution. See [`docs/agent-runtime.md`](agent-runtime.md) for the operational reference.
