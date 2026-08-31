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
- browser persistence of API credentials,
- unrestricted arbitrary runtime mutation,
- a second source of execution state separate from the durable runtime/event log.

Those can build on this control-plane foundation later.

## Design Principles

1. **Runtime remains authoritative.** The browser only renders state returned by the API and invokes explicit API actions.
2. **Live by default, replayable after disconnect.** Event delivery uses SSE with sequence cursors so a reconnect can resume without silently dropping durable events.
3. **Bounded resource usage.** Live clients, replay windows, heartbeat cadence, queued outbound bytes, polling cadence, and reconnect delays are capped.
4. **Fail closed on control actions.** Missing/invalid credentials, malformed identifiers, or invalid lifecycle transitions are rejected by the API.
5. **No framework dependency in v1.** The dashboard remains first-party HTML/CSS/JavaScript using browser primitives, keeping the root dependency surface unchanged.
6. **Same-origin by default.** Helix serves the console itself. The browser does not need wildcard CORS or a separate dev server to operate the local control plane.
7. **Progressive enhancement.** The console can fetch initial snapshots over ordinary JSON APIs; SSE augments them with live deltas.
8. **No duplicate state model.** The client derives view state from API snapshots plus ordered events and can re-fetch authoritative state whenever stream continuity is uncertain.

## Architecture

The feature has three layers.

### 1. Same-origin console delivery

The Helix API process serves the first-party dashboard at `/` and its static assets under `/dashboard/`.

The dashboard uses `window.location.origin` as its API origin. No API base URL or API credential is stored in `localStorage`.

If a deployment intentionally needs cross-origin API access, it must set `HELIX_CORS_ORIGIN` explicitly. When that variable is absent, API responses do not emit `Access-Control-Allow-Origin: *`.

This is a deliberate security hardening from the existing permissive CORS default. Same-origin dashboard delivery removes the need for wildcard CORS in the common local deployment.

### 2. API live-event transport

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

### 3. Snapshot/control API and browser console

The existing API already exposes health, agents, executions, execution detail, approvals, telemetry, events, and lifecycle actions. This phase keeps those routes as the authoritative snapshot/control plane and adds only narrowly scoped additions needed for the console.

Required API additions/changes:

- `GET /api/v1/events?after=<sequence>&limit=<n>` for bounded replay/snapshot reads.
- `GET /api/v1/events/stream` for live ordered delivery.
- static console delivery from the same HTTP server.
- secure CORS behavior: same-origin by default; explicit configured origin only when enabled.

Existing authoritative controls remain unchanged:

- execution detail: `GET /api/v1/executions/:id`
- lifecycle: pause, resume, cancel, retry, checkpoint
- approvals: approve, deny

No browser-only mutation path is introduced.

## Browser Operations Console

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

A client first fetches its required JSON snapshots and records the highest durable sequence reported by `/health` or the highest sequence returned by `/events`. It then connects to `/api/v1/events/stream?after=<sequence>`.

This order avoids a snapshot/subscribe race while still allowing replay of events emitted between snapshot fetch and stream connection.

### Reconnect

The browser records the last successfully processed SSE event ID in memory. On reconnect it resumes after that sequence.

The server validates the cursor as a non-negative safe integer. Invalid cursors return `400`.

### Replay bounds

A stream connection may replay at most 1,000 durable events before joining live fan-out. If more than 1,000 events exist after the supplied cursor, the server returns `409` with a machine-readable `resync_required` error instead of silently truncating or flooding the client.

The JSON `/events` endpoint also caps `limit` at 1,000.

### Fixed v1 defaults

- replay maximum: 1,000 events,
- JSON `/events` maximum: 1,000 events,
- live event polling interval inside the API adapter: 500 ms,
- SSE heartbeat: 15 seconds,
- active SSE clients: 64,
- per-client pending outbound bytes: 262,144 bytes,
- browser reconnect backoff: 500 ms initial, doubling to a 10-second maximum, reset after a healthy stream is established.

The server-side limits may be overridden through validated environment variables, but configured values must remain positive bounded integers. The browser reconnect constants are fixed in v1.

## Live Delivery Implementation

The runtime event store is durable but does not currently expose a browser subscription primitive. The API therefore owns a small `EventStreamHub` adapter.

`EventStreamHub` responsibilities:

- maintain connected SSE clients,
- read durable events after the globally observed sequence every 500 ms while at least one client exists,
- fan out each new durable event exactly once per connected client in sequence order,
- perform per-client replay before joining live fan-out,
- emit 15-second heartbeat comments,
- cap clients and pending writes,
- remove clients on disconnect/error,
- stop timers when no clients are connected,
- never mutate runtime execution state.

This is an API transport adapter, not a new event store.

A future internal event-store subscription API can replace the polling adapter without changing the browser protocol.

## Authentication and API-Key Handling

The existing API uses an optional bearer token configured through `HELIX_API_KEY`.

Native `EventSource` cannot set arbitrary Authorization headers. Therefore the console uses `fetch()` with a streaming SSE parser, allowing the same `Authorization: Bearer ...` header used by JSON requests.

If the API requires authentication, the console presents an operator credential input. The key is held only in JavaScript memory for the lifetime of the loaded page. It is not placed in:

- query strings,
- `localStorage`,
- `sessionStorage`,
- cookies,
- HTML source,
- durable events.

Reloading the page requires re-entry unless a future dedicated authentication/session design is added.

## CORS and Same-Origin Policy

The API keeps its current `127.0.0.1` default bind behavior.

CORS behavior becomes:

- no `HELIX_CORS_ORIGIN`: no cross-origin allow header; same-origin console works normally,
- configured `HELIX_CORS_ORIGIN`: emit that exact origin and permit the existing authorization/content-type headers,
- wildcard `*` is accepted only if the operator explicitly configures it.

Preflight handling follows the same configured-origin rule. Tests must prove the default response does not silently emit wildcard CORS.

## Control Actions

Control buttons are enabled according to current rendered status for usability, but browser state is never enforcement.

Every action is sent to the existing API lifecycle route and the API/runtime decides whether the transition is valid.

The UI requires explicit confirmation for destructive/high-impact actions:

- cancel execution,
- deny approval.

Pause/resume/retry/checkpoint execute directly but surface returned errors in an operator-safe status area.

After a successful mutation, the UI applies the returned authoritative object and then relies on durable events/snapshot refresh for convergence.

## Task Graph Presentation

The console does not introduce a graph-layout dependency in v1.

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
- replay backlog above configured maximum -> `409` with `{ error: "resync_required" }`,
- write/backpressure overflow -> disconnect only that client,
- request/stream errors must not crash the API process.

### Browser

- authentication failure -> stop automatic reconnect and prompt for credentials,
- network interruption -> bounded 500 ms to 10 s exponential reconnect,
- sequence gap -> re-fetch snapshots and restart stream from authoritative sequence,
- malformed SSE payload -> discard payload, mark stream unhealthy, resync,
- mutation failure -> show API error and keep current authoritative state unchanged.

## Dashboard File Structure

Keep the implementation small and dependency-free:

- `apps/dashboard/index.html` — semantic shell and module entry point,
- `apps/dashboard/src/app.js` — application bootstrap and view coordination,
- `apps/dashboard/src/api.js` — authenticated JSON + streaming SSE fetch client,
- `apps/dashboard/src/state.js` — small in-memory state/reducer helpers,
- `apps/dashboard/src/render.js` — DOM rendering and control wiring,
- `apps/dashboard/src/styles.css` — operations-console styling.

The API serves these files directly. Static paths are fixed first-party paths, not arbitrary filesystem paths from request input.

If tests require importable logic under Node, pure parsing/state helpers may live in TypeScript under a small shared/dashboard package boundary, but browser runtime remains dependency-free.

## API Refactor Boundary

`apps/api/src/index.ts` currently carries routing, auth, rate limiting, request parsing, CORS, and server startup in one file. This feature should avoid expanding it further.

Targeted refactor:

- `apps/api/src/http.ts` — JSON/body/auth/rate/CORS helpers,
- `apps/api/src/event-stream.ts` — SSE hub, cursor parsing, replay validation,
- `apps/api/src/routes.ts` — API and fixed dashboard route composition,
- `apps/api/src/index.ts` — environment wiring, runtime init, server startup/shutdown.

This refactor is limited to responsibilities touched by the live console; it is not a general rewrite.

## Testing Strategy

Development follows TDD.

### API/SSE tests

Add tests that prove:

- the first-party dashboard is served from the API origin,
- default responses do not emit wildcard CORS,
- explicitly configured CORS uses the exact configured origin,
- protected SSE rejects missing/wrong credentials,
- replay starts strictly after the supplied sequence,
- `Last-Event-ID` resume works,
- conflicting resume cursors fail closed,
- live events arrive in durable sequence order,
- heartbeat frames do not masquerade as Helix events,
- invalid cursors and limits are rejected,
- replay and client caps are enforced,
- disconnect removes client resources/timers,
- a slow/overflowing client is dropped without affecting other clients,
- existing JSON and lifecycle routes remain compatible.

### Dashboard logic tests

Test pure helpers for:

- SSE frame parsing across arbitrary chunk boundaries,
- sequence-gap detection,
- reducer updates for execution/approval/event changes,
- reconnect state transitions,
- safe rendering/escaping helpers where text from runtime events is displayed.

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

- dashboard assets are served only from fixed first-party paths,
- SSE endpoint uses the same auth policy as protected JSON routes,
- API keys never enter query strings, browser storage, HTML source, logs, or durable events,
- default CORS is same-origin rather than wildcard,
- no runtime action is authorized by browser state,
- event/replay parameters are bounded integers,
- outbound SSE buffering is bounded,
- disconnected clients/timers are cleaned up,
- event payload rendering does not allow script/HTML injection,
- control action identifiers are encoded and validated,
- no new arbitrary command/file/network capability is introduced.

## Delivery Sequence

1. Refactor touched API HTTP helpers without behavior changes except the explicitly designed CORS hardening.
2. Serve the fixed first-party dashboard from the same API origin.
3. Add bounded event query/replay semantics.
4. Add `EventStreamHub` and authenticated SSE transport.
5. Add dashboard streaming client and state model.
6. Add live overview/executions/event feed.
7. Add execution detail/task status and lifecycle controls.
8. Add approvals and telemetry views.
9. Run security/diff review and full CI.
10. Merge only from an exact reviewed/green head and verify `main` post-merge.

## Success Criteria

This phase is complete when an operator can open the first-party Helix dashboard from the Helix server, authenticate when required, see current runtime/execution state, receive durable events live with reconnect/replay semantics, inspect an execution and its tasks, operate lifecycle controls, handle approvals, and inspect telemetry without manual full-page refreshes or trusting the browser for authorization.
