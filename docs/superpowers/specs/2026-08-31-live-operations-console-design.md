# Helix Live Operations Console — Design

## Status

Approved direction: build a first-party live operations console on top of the existing Helix API/runtime before adding broader multi-model chat or MCP browsing UX.

## Goal

Turn the existing static dashboard into an operational control plane for Helix. Operators should be able to observe executions in real time, inspect task-level state and runtime health, act on execution lifecycle controls, review approvals, and inspect telemetry without relying on repeated full-page polling.

The console is an operations surface, not a security boundary. Authorization, validation, lifecycle rules, and policy decisions remain enforced by the API/runtime.

## Non-Goals

This phase does not add:

- a full multi-model chat product,
- a visual MCP marketplace/tool gallery,
- plugin installation from the browser,
- a React/Vite/Next.js build pipeline,
- browser-side persistence of secrets beyond the existing optional API-key flow,
- unrestricted arbitrary runtime mutation,
- a second source of execution state separate from the durable runtime/event log.

Those can build on this control-plane foundation later.

## Design Principles

1. **Runtime remains authoritative.** The browser only renders state returned by the API and invokes explicit API actions.
2. **Live by default, replayable after disconnect.** Event delivery uses SSE with sequence cursors so a reconnect can resume without silently dropping durable events.
3. **Bounded resource usage.** Live clients, replay windows, heartbeat cadence, and queued outbound bytes are capped.
4. **Fail closed on control actions.** Missing/invalid credentials, malformed identifiers, or invalid lifecycle transitions are rejected by the API.
5. **No framework dependency in v1.** The dashboard remains first-party HTML/CSS/TypeScript/JavaScript using browser primitives, keeping the root dependency surface unchanged.
6. **Progressive enhancement.** The console can still fetch initial snapshots over ordinary JSON APIs; SSE augments them with live deltas.
7. **No duplicate state model.** The client derives view state from API snapshots plus ordered events and can re-fetch authoritative state whenever stream continuity is uncertain.

## Architecture

The feature has three layers.

### 1. API live-event transport

Add an authenticated SSE endpoint:

`GET /api/v1/events/stream`

The endpoint streams durable Helix events in increasing sequence order.

The client may resume with either:

- `Last-Event-ID` header, or
- `?after=<sequence>` query parameter.

If both are present they must agree; otherwise the request is rejected as ambiguous.

Each SSE event uses:

- `id: <event.sequence>`
- `event: helix.event`
- `data: <JSON event>`

The server sends periodic comment heartbeats so intermediaries and clients can detect dead connections without inventing synthetic runtime events.

The stream never bypasses API authentication. If `HELIX_API_KEY` is configured, the request must be authorized exactly like other protected API routes.

### 2. Snapshot/control API extensions

The existing API already exposes health, agents, executions, execution detail, approvals, telemetry, events, and lifecycle actions. This phase keeps those routes as the authoritative snapshot/control plane and adds only narrowly scoped additions needed for the console.

Required additions:

- `GET /api/v1/events?after=<sequence>&limit=<n>` for bounded replay/snapshot reads.
- `GET /api/v1/executions/:id` remains the execution detail source.
- existing lifecycle routes remain the mutation surface:
  - pause
  - resume
  - cancel
  - retry
  - checkpoint
- existing approval routes remain the approval mutation surface:
  - approve
  - deny

No browser-only mutation path is introduced.

### 3. Browser operations console

Replace the current polling-only page with a first-party operations console that loads an initial snapshot and then subscribes to the SSE stream.

Primary views:

- **Overview** — runtime/provider state, durable event sequence, execution counts, pending approvals, active agents, telemetry summary.
- **Executions** — execution list with status, goal, timestamps, current revision, and controls.
- **Execution detail** — task graph/table with task status, dependencies, assigned agent, attempts, failure/supersession/replan evidence, and recent execution-scoped events.
- **Agents** — registered agents and capabilities with runtime-visible status.
- **Approvals** — pending approvals with explicit approve/deny actions and decision metadata.
- **Telemetry** — counters/metrics/log summaries already returned by the runtime telemetry snapshot.
- **Event stream** — bounded recent event feed for operational debugging.

The UI updates affected panels incrementally when live events arrive. If it encounters an unknown event type or detects a sequence gap, it does not guess state; it refreshes the affected authoritative snapshot.

## SSE State and Replay Semantics

### Sequence source

The durable event store sequence is the only ordering cursor. The API must not create a second independent stream sequence.

### Initial connection

A client first fetches its required JSON snapshots and records the highest durable sequence observed from `/health` or `/events`. It then connects to `/events/stream?after=<sequence>`.

This order avoids the common subscribe-then-snapshot race while still allowing replay of events emitted between snapshot fetch and stream connection.

### Reconnect

The browser records the last successfully processed SSE event ID in memory. On reconnect it resumes after that sequence.

The server validates the cursor as a non-negative safe integer. Invalid cursors return `400`.

### Replay bounds

A single stream connection may replay only a configured bounded number of historical events before switching to live delivery. If the requested cursor is too far behind the retained/readable window, the server returns a conflict/resync response rather than flooding the client.

Default design limits:

- replay batch: 1,000 events,
- JSON `/events` limit: maximum 1,000,
- SSE heartbeat: 15 seconds,
- active SSE clients: configurable, default 64,
- per-client pending outbound bytes: bounded; slow consumers are disconnected.

Exact constants remain configurable through environment variables with validated integer bounds.

## Live Delivery Implementation

The runtime event store is durable but does not currently expose a browser subscription primitive. The API therefore owns a small `EventStreamHub` adapter.

`EventStreamHub` responsibilities:

- maintain the set of connected SSE clients,
- poll/read only for durable events after the globally observed sequence at a short bounded interval,
- fan out each new durable event exactly once per connected client in sequence order,
- perform per-client replay before joining live fan-out,
- emit heartbeat comments,
- cap clients and pending writes,
- remove clients on disconnect/error,
- stop timers when no clients are connected,
- never mutate runtime execution state.

This is intentionally an API transport adapter, not a new event store.

A future internal event-store subscription API can replace the short polling adapter without changing the browser protocol.

## Authentication and Browser API-Key Handling

The existing API uses an optional bearer token configured through `HELIX_API_KEY`.

Native `EventSource` cannot set arbitrary Authorization headers. Therefore the console will not use raw `EventSource` when API-key auth is enabled. It will use `fetch()` with an SSE parser over the response body, allowing the same `Authorization: Bearer ...` header used by JSON requests.

The console may accept an API key from an operator-controlled input for the current browser session. By default it is kept in memory/session scope rather than embedded in source code or URL query strings. The API key must never be placed in the SSE URL.

## Control Actions

Control buttons are enabled according to the current rendered status for usability, but that is not enforcement.

Every action is sent to the existing API lifecycle route and the API/runtime decides whether the transition is valid.

The UI requires an explicit confirmation for destructive/high-impact actions:

- cancel execution,
- deny approval.

Pause/resume/retry/checkpoint may execute directly but surface returned errors verbatim in an operator-safe status area.

After a successful mutation, the UI applies the returned authoritative object and then relies on subsequent durable events/snapshot refresh for convergence.

## Task Graph Presentation

The console should not introduce a graph-layout dependency in v1.

Execution detail renders tasks as a dependency-aware table/list with:

- task id,
- title/description if present,
- status,
- dependencies,
- assigned agent,
- attempt count,
- superseded/replacement relationship,
- failure/replan evidence.

A lightweight CSS/SVG graph can be added later after the data contract is stable.

## Error Handling

### API

- invalid `after`/`limit` values -> `400`,
- unauthorized stream -> `401`,
- active-client cap reached -> `503`,
- stale replay cursor beyond configured window -> `409` with resync instruction,
- write/backpressure overflow -> disconnect that client,
- request/stream errors must not crash the API process.

### Browser

- authentication failure -> stop automatic reconnect and prompt for credentials,
- network interruption -> bounded exponential reconnect,
- sequence gap -> re-fetch snapshots and restart stream from authoritative sequence,
- malformed SSE payload -> discard the payload, mark stream unhealthy, resync,
- mutation failure -> show API error and keep current authoritative state unchanged.

## Dashboard File Structure

Keep the implementation small and dependency-free:

- `apps/dashboard/index.html` — semantic shell and loading entry point,
- `apps/dashboard/src/app.js` — application bootstrap and view coordination,
- `apps/dashboard/src/api.js` — authenticated JSON + SSE fetch client,
- `apps/dashboard/src/state.js` — small in-memory state/reducer helpers,
- `apps/dashboard/src/render.js` — DOM rendering and control wiring,
- `apps/dashboard/src/styles.css` — operations-console styling.

If tests require importable logic under Node, pure parsing/state helpers may live in TypeScript under a small shared/dashboard package boundary, but browser runtime stays dependency-free.

## API Refactor Boundary

`apps/api/src/index.ts` is already carrying routing, auth, rate limiting, request parsing, and server startup in one file. This feature should avoid expanding it into an even larger monolith.

Targeted refactor:

- `apps/api/src/http.ts` — reusable JSON/body/auth/rate helpers,
- `apps/api/src/event-stream.ts` — SSE hub and replay validation,
- `apps/api/src/routes.ts` — route handler composition,
- `apps/api/src/index.ts` — environment wiring, runtime init, server startup/shutdown.

This refactor is limited to responsibilities touched by the live console; it is not a general rewrite.

## Testing Strategy

Development follows TDD.

### API/SSE tests

Add tests that prove:

- protected SSE rejects missing/wrong credentials,
- replay starts strictly after the supplied sequence,
- `Last-Event-ID` resume works,
- conflicting resume cursors fail closed,
- live events arrive in durable sequence order,
- heartbeat frames do not masquerade as Helix events,
- invalid cursors and limits are rejected,
- replay and client caps are enforced,
- disconnect removes client resources,
- a slow/overflowing client is dropped without affecting other clients,
- existing JSON and lifecycle routes remain compatible.

### Dashboard logic tests

Test pure helpers for:

- SSE frame parsing across arbitrary chunk boundaries,
- sequence-gap detection,
- reducer updates for execution/approval/event changes,
- reconnect state transitions,
- safe rendering/escaping helpers where string interpolation is used.

### Full verification

Required before merge:

- `pnpm install --frozen-lockfile --ignore-scripts`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- PR CI on the exact reviewed head
- post-merge CI on `main`

## Security Review Checklist

Before merge verify:

- SSE endpoint uses the same auth policy as protected JSON routes,
- API keys never enter query strings, HTML source, logs, or durable events,
- no runtime action is authorized by browser state,
- event/replay parameters are bounded integers,
- outbound SSE buffering is bounded,
- disconnected clients/timers are cleaned up,
- event payload rendering does not allow script/HTML injection,
- control action identifiers are encoded and validated,
- CORS behavior does not silently widen beyond configured policy,
- no new arbitrary command/file/network capability is introduced.

## Delivery Sequence

1. Refactor the touched API HTTP helpers without behavior change.
2. Add bounded event query/replay semantics.
3. Add `EventStreamHub` and authenticated SSE transport.
4. Add dashboard API/SSE client and state model.
5. Add live overview/executions/event feed.
6. Add execution detail/task status and lifecycle controls.
7. Add approvals and telemetry views.
8. Run security/diff review and full CI.
9. Merge only from an exact reviewed/green head and verify `main` post-merge.

## Success Criteria

This phase is complete when an operator can open the first-party Helix dashboard, authenticate when required, see current runtime/execution state, receive durable events live with reconnect/replay semantics, inspect an execution and its tasks, operate lifecycle controls, handle approvals, and inspect telemetry without requiring manual full-page refreshes or trusting the browser for authorization.
