# Helix Live Operations Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the polling-only dashboard with a same-origin, authenticated live operations console backed by bounded durable-event replay, SSE streaming, execution controls, approvals, and telemetry.

**Architecture:** Refactor only the touched API HTTP concerns into testable helpers and a server factory, then add a bounded `EventStreamHub` over the existing durable `EventStore`. Serve fixed first-party dashboard assets from the API origin; the browser uses ordinary fetch plus a bounded streaming SSE parser and derives view state from authoritative snapshots plus ordered durable events.

**Tech Stack:** TypeScript 5.9, Node.js 22 HTTP/streams/fs, browser HTML/CSS/ES modules, node:test, existing Helix runtime/EventStore, GitHub Actions. No new runtime/frontend dependency.

**Spec:** `docs/superpowers/specs/2026-08-31-live-operations-console-design.md`

## Global Constraints

- Runtime/EventStore remains authoritative; do not add a second persisted dashboard state store.
- Same-origin is the default. When `HELIX_CORS_ORIGIN` is unset, do not emit wildcard or any cross-origin allow header.
- API credentials must never enter URLs, browser storage, HTML source, logs, or durable events.
- SSE cursor is the durable event sequence only.
- Replay max is 1,000; JSON event limit max is 1,000; live poll default is 500 ms; heartbeat default is 15 s; client cap default is 64; pending outbound bytes default is 262,144.
- Browser reconnect starts at 500 ms, doubles to at most 10 s, and resets after a healthy stream starts.
- Dashboard assets are served only from fixed first-party paths, never from request-controlled filesystem paths.
- Control buttons are usability only; all authorization and lifecycle validation remains API/runtime-side.
- No React/Vite/Next.js or graph-layout dependency in v1.
- `pnpm install --frozen-lockfile --ignore-scripts`, typecheck, build, all tests, exact-head PR CI, and post-merge `main` CI are mandatory.

---

### Task 1: Testable API server boundary and secure same-origin static delivery

**Files:**
- Create: `apps/api/src/http.ts`
- Create: `apps/api/src/routes.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/dashboard/index.html`
- Test: `tests/api-console-http.test.ts`

**Interfaces:**
- Produce `HttpSecurityOptions { apiKey?: string; corsOrigin?: string; maxBodyBytes: number; rateLimitPerMinute: number }`.
- Produce `createHttpHelpers(options)` with `json(response,status,body)`, `readJsonBody(request)`, `authorized(request,pathname)`, `withinRateLimit(request)`, and `corsHeaders()`.
- Produce `createHelixRequestHandler({ runtime, security, dashboardRoot, eventStream? }): (request,response) => Promise<void>`.
- `apps/api/src/index.ts` owns environment parsing/runtime initialization/server startup only.
- Fixed dashboard routes: `/` -> `apps/dashboard/index.html`; `/dashboard/app.js`, `/dashboard/api.js`, `/dashboard/state.js`, `/dashboard/render.js`, `/dashboard/styles.css` map to explicit known files only.

- [ ] **Step 1: Write RED integration tests.** Start an HTTP server on port `0` using `createHelixRequestHandler`; assert `/` returns the dashboard, default `/api/v1/health` has no `access-control-allow-origin`, configured CORS returns exactly the configured origin, existing health/agents/executions routes still work, and unknown `/dashboard/../../...` paths return `404` rather than reading arbitrary files.
- [ ] **Step 2: Run the RED commit.** Expected: typecheck fails because the server factory/helpers do not exist.
- [ ] **Step 3: Implement the minimal refactor.** Move body/auth/rate/CORS/JSON helpers without changing existing route behavior except the designed CORS hardening. Route dashboard assets with a literal pathname-to-file map and content types; do not use request path concatenation.
- [ ] **Step 4: Make `index.ts` wire the factory.** Parse positive bounded environment integers, initialize `HelixRuntime`, create the handler/server, and preserve SIGINT/SIGTERM shutdown.
- [ ] **Step 5: Run full CI.** Existing API behavior and the new same-origin/static/CORS tests must pass.
- [ ] **Step 6: Review Task 1** for path traversal, wildcard CORS regression, auth bypass, body-limit regression, and import-time server side effects in tests.

---

### Task 2: Bounded event query and replay primitives

**Files:**
- Create: `apps/api/src/events.ts`
- Modify: `apps/api/src/routes.ts`
- Test: `tests/api-events.test.ts`

**Interfaces:**
- Produce `parseSequence(value,name): number` accepting only decimal non-negative safe integers.
- Produce `parseLimit(value,{defaultValue,max}): number` accepting only positive safe integers up to `max`.
- Produce `readEventsAfter(store, after, limit): Promise<{ events: EventEnvelope[]; sequence: number; hasMore: boolean }>` where returned events satisfy `event.sequence > after`, are increasing, and contain at most `limit` items.
- `/api/v1/events?after=<n>&limit=<n>` returns `{ events, sequence: runtime.events.lastSequence, hasMore }`.
- Existing `/api/v1/events` with no query remains valid but now returns a bounded default page rather than an unbounded log dump.

- [ ] **Step 1: Write RED tests** for strict-after ordering, default/explicit limits, `limit=1001`, negative/fractional/unsafe/garbage cursors, and `hasMore` when an extra event exists.
- [ ] **Step 2: Verify RED** on missing parser/query primitives.
- [ ] **Step 3: Implement pure parsers/query helper.** Read from the existing `EventStore`, filter strictly after cursor, take `limit + 1` only in memory to determine `hasMore`, and return cloned ordered events.
- [ ] **Step 4: Wire `/api/v1/events`.** Map validation errors to `400` with the existing JSON error shape.
- [ ] **Step 5: Run full CI and review** for unbounded allocations, off-by-one cursor semantics, unsafe integers, and legacy event endpoint compatibility.

---

### Task 3: Authenticated bounded `EventStreamHub` and SSE endpoint

**Files:**
- Create: `apps/api/src/event-stream.ts`
- Modify: `apps/api/src/routes.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/api-event-stream.test.ts`

**Interfaces:**
- Produce `EventStreamOptions { replayMax?: number; pollMs?: number; heartbeatMs?: number; maxClients?: number; maxPendingBytes?: number }` with defaults `1000/500/15000/64/262144` and bounded positive integer validation.
- Produce `parseResumeCursor(request,url): number` using `Last-Event-ID` or `after`; both may be absent (`0`), but if both exist they must be equal.
- Produce `EventStreamHub({ store, options })` with `handle(request,response,url): Promise<void>`, `close(): Promise<void>`, and inspection-only `clientCount` for tests.
- SSE frames are exactly `id: <sequence>\nevent: helix.event\ndata: <JSON>\n\n`; heartbeat is a comment frame such as `: heartbeat\n\n` with no event ID.
- Before opening a `200` stream, read up to `replayMax + 1` events after the cursor; if more than `replayMax`, return `409 {"error":"resync_required"}`.
- Streaming endpoint remains behind the same API bearer-auth check as protected routes.

- [ ] **Step 1: Write RED transport tests.** Cover missing/wrong auth, strict replay after cursor, `Last-Event-ID`, conflicting cursor sources, backlog `409`, live append delivery in order, heartbeat comments, max-client `503`, disconnect cleanup, and one overflowing client being removed without closing another client.
- [ ] **Step 2: Verify RED** because `EventStreamHub` does not exist.
- [ ] **Step 3: Implement cursor/replay validation and SSE response headers.** Use `text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`, and no synthetic runtime events.
- [ ] **Step 4: Implement live fan-out.** While at least one client exists, poll `EventStore.read()` on the configured interval, select events after the hub global sequence, and deliver each ordered event to clients whose last sequence is lower.
- [ ] **Step 5: Implement bounded writes/cleanup.** Track pending byte count per client; if a write would exceed the limit, disconnect only that client. Stop polling/heartbeat timers when the final client leaves; `close()` clears every timer/client.
- [ ] **Step 6: Wire `/api/v1/events/stream` before ordinary JSON route completion.** The route handler must not attempt to send a second response after the stream takes ownership.
- [ ] **Step 7: Run full CI and review** for timer leaks, double writes, replay/live duplication, auth/CORS handling, slow consumers, and process-crash propagation.

---

### Task 4: Browser SSE parser, API client, and authoritative state model

**Files:**
- Create: `apps/dashboard/src/api.js`
- Create: `apps/dashboard/src/state.js`
- Create: `tests/dashboard-client.test.ts`

**Interfaces:**
- `createApiClient({ origin, getToken })` exposes `json(path, options?)` and `streamEvents({ after, signal, onOpen, onEvent })`.
- API token is read from `getToken()` at request time and placed only in the `Authorization` header.
- `createSseParser(onFrame)` accepts arbitrary `Uint8Array`/string chunks and emits complete `{ id?, event?, data? }` frames; comments are ignored.
- State helpers: `createConsoleState()`, `applySnapshot(state,snapshot)`, `applyHelixEvent(state,event)`, and `nextReconnectDelay(previous)`.
- `applyHelixEvent` accepts only the next sequence (`lastSequence + 1`), ignores exact duplicates, and returns `{ state, resyncRequired: true }` on a forward gap or malformed sequence.
- Recent events remain capped to 200 client-side entries.

- [ ] **Step 1: Write RED pure-logic tests.** Dynamically import the source ES modules from the compiled Node test and cover chunk-split SSE fields, multi-frame chunks, comments, malformed JSON handling, sequence duplicates/gaps, capped recent events, execution/approval event updates, and reconnect progression `500,1000,2000,...,10000`.
- [ ] **Step 2: Verify RED** on missing modules/functions.
- [ ] **Step 3: Implement the streaming parser/client.** Use `fetch` + `ReadableStreamDefaultReader`; never put the token in a URL or browser storage. Abort stops the reader cleanly; HTTP `401` surfaces as an auth-specific error; `409 resync_required` surfaces as a resync-specific error.
- [ ] **Step 4: Implement the small reducer/state helpers.** Prefer replacing authoritative objects from event payloads when present; unknown event types only advance the event feed/sequence and may mark snapshot refresh required rather than inventing domain state.
- [ ] **Step 5: Run full CI and review** for token leakage, unbounded browser buffers, UTF-8 chunk boundaries, duplicate event application, and reconnect storms.

---

### Task 5: Live operations console rendering and governed controls

**Files:**
- Rewrite: `apps/dashboard/index.html`
- Create: `apps/dashboard/src/app.js`
- Create: `apps/dashboard/src/render.js`
- Create: `apps/dashboard/src/styles.css`
- Extend: `tests/dashboard-client.test.ts`
- Extend: `tests/api-console-http.test.ts`

**Interfaces:**
- Console navigation has Overview, Executions, Agents, Approvals, Telemetry, Events.
- Initial snapshot fetches `/health`, `/agents`, `/executions`, `/approvals?status=pending`, `/telemetry`, and bounded `/events?limit=200`.
- Selecting an execution fetches `/executions/:id` and renders `execution`, `tasks`, `planRevision`, and scoped events.
- Lifecycle buttons POST only to existing encoded routes: `pause|resume|cancel|retry|checkpoint`.
- Approval actions POST only to existing encoded `approve|deny` routes; deny and cancel require `window.confirm`.
- Rendering uses DOM text nodes/`textContent`; do not insert runtime strings with `innerHTML`.
- Credential modal/input is shown only when health reports auth required or a protected request returns `401`; token lives in a module variable only.

- [ ] **Step 1: Write RED source/security tests.** Assert dashboard HTML references same-origin `/dashboard/...` assets and contains no `localStorage`, API URL, or embedded bearer token; assert render helper uses text-safe DOM construction and encoded identifiers for mutation URLs.
- [ ] **Step 2: Implement semantic shell/styles.** Build responsive dark operations layout with connection/auth status, summary cards, navigation, detail pane, tables, and operator status area; no framework/build dependency.
- [ ] **Step 3: Implement renderer.** Render cards/executions/tasks/agents/approvals/telemetry/events through `createElement` + `textContent`, attach delegated action handlers, and expose explicit confirmation for cancel/deny.
- [ ] **Step 4: Implement app orchestration.** Load snapshot, establish SSE strictly after snapshot sequence, apply ordered events, refresh authoritative snapshots on unknown/gap/resync, and reconnect with bounded exponential backoff.
- [ ] **Step 5: Add execution detail/control behavior and approval/telemetry refresh.** Mutation success replaces returned authoritative state then lets SSE converge; mutation failure leaves prior state intact and surfaces the API error.
- [ ] **Step 6: Run full CI and inspect served dashboard routes** for content types, same-origin URLs, no credential storage, and no runtime-string HTML injection.

---

### Task 6: Final security/compatibility review and delivery

**Files:**
- Modify: `README.md` only to document the live console URL/auth/CORS environment behavior.
- Modify: design/plan docs only if final implementation intentionally differs; do not rewrite history to hide gaps.
- Tests: all existing/new tests.

- [ ] **Step 1: Run fresh repository verification:** `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
- [ ] **Step 2: Review compare against `main`.** Confirm changes are limited to API transport/refactor, dashboard, tests/docs; inspect auth, CORS, path serving, SSE limits/cleanup, browser token handling, rendering safety, and control URL encoding.
- [ ] **Step 3: Add RED regressions for every Important/Critical issue found in review, then fix them and rerun full CI.**
- [ ] **Step 4: Open PR from the exact verified head.** Run pull-request CI independently; do not merge from an unverified new head.
- [ ] **Step 5: Squash merge with `expected_head_sha`.**
- [ ] **Step 6: Verify post-merge `main` CI** and read the test summary before calling the phase complete.
