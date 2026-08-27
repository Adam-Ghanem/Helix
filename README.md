# Helix

> **Coordinate Intelligence.**

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/Adam-Ghanem/Helix/ci.yml?label=CI" alt="CI">
  <img src="https://img.shields.io/github/license/Adam-Ghanem/Helix" alt="License">
  <img src="https://img.shields.io/github/stars/Adam-Ghanem/Helix" alt="GitHub stars">
  <img src="https://img.shields.io/github/commit-activity/m/Adam-Ghanem/Helix" alt="Commit activity">
</p>

Helix is an **autonomous multi-agent orchestration runtime** built to coordinate intelligent agents, tools, workflows, memory, and execution state through one controlled system.

The core idea is simple: **the model is replaceable; the orchestration layer is not.** Helix owns scheduling, routing, permissions, recovery, coordination, observability, and durable execution evidence.

## ⚡ Highlights

- 🤖 Multi-agent execution and coordination
- 🧠 Observe → interpret → plan → act → evaluate runtime
- ⚙️ Capability-aware routing and adaptive scheduling
- 🧩 Task DAGs and declarative workflows
- 🐝 Swarm topologies and consensus strategies
- 🔐 Default-deny policies and human approval gates
- 💾 Durable event log, replay, snapshots and recovery
- 🧠 Structured memory and provenance-aware knowledge
- 🔌 Provider-neutral model runtime and MCP boundaries
- 📊 Telemetry, evaluation and execution evidence
- 🛡️ Sandboxing, command controls and secret boundaries
- 📦 TypeScript SDK, CLI and HTTP API

## 🏗️ Architecture

```text
                         ┌──────────────────┐
                         │   CLI / SDK / API │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │ Execution Runtime│
                         └────────┬─────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
       ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
       │   Planner   │     │    Router   │     │  Scheduler  │
       │  Task DAGs  │     │ Capabilities│     │ Leases/Load │
       └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │      Agent / Tool Layer   │
                    │ Agents • MCP • Providers  │
                    └─────────────┬─────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
       ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
       │   Memory    │     │  Knowledge  │     │ Observability│
       │  & Evidence │     │ Provenance  │     │ & Evaluation │
       └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  │
                         ┌────────▼─────────┐
                         │ Durable State    │
                         │ Events / Replay  │
                         └──────────────────┘
```

Helix separates **planning, routing, scheduling, execution, policy, memory, coordination, and persistence** so intelligent behavior remains observable, controllable, and recoverable.

## 🧠 How Helix Works

A task enters the runtime and is transformed into a validated execution plan. Helix selects agents and tools based on capabilities and runtime conditions, applies policy before sensitive actions, executes through controlled boundaries, records structured evidence, and evaluates the resulting trajectory.

This makes the system **model-agnostic**: different model providers can power the reasoning layer without taking ownership of the orchestration state.

## 🔐 Security by Design

Helix treats agent execution as a controlled system rather than unrestricted model output.

- Default-deny policy decisions
- Explicit approval gates
- Auditable tool requests
- Bounded command and environment controls
- Execution timeouts and resource budgets
- Replay protection and durable lifecycle events
- Structured decision metadata instead of private chain-of-thought
- Provider-neutral model boundary

## 🚀 Quick Start

```bash
pnpm install
pnpm verify
pnpm dev:api
```

In another terminal:

```bash
pnpm dev:cli run "Review this repository architecture"
```

For JSON output:

```bash
pnpm dev:cli run "Review this repository architecture" --json
```

Helix can run with its deterministic local provider or connect to an OpenAI-compatible model endpoint through configuration.

## 🧱 Built With

- **TypeScript**
- Node.js
- Durable event-driven runtime
- Task DAG orchestration
- Provider-neutral model adapters
- MCP security boundaries
- HTTP API + CLI + SDK
- Automated tests and verification

## 🏅 Engineering Quality

Helix uses automated **CI, strict type checking, builds, tests, dependency auditing, and security-focused controls** as part of its engineering workflow.

## 📄 License

Helix is released under the **Apache-2.0 License**. See [`LICENSE`](LICENSE) for the full license text.

## 🔭 Vision

Helix aims to provide the **orchestration layer for reliable autonomous software** — where agents can reason and collaborate, while the system around them owns execution, safety, memory, coordination, and recovery.

## 🤝 Contributing

Contributions, ideas, experiments, and improvements are welcome.

---

<p align="center">
  <strong>Helix</strong><br>
  <em>Coordinate Intelligence.</em>
</p>
