# Federation Result Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable authenticated federation task/result plane.

**Architecture:** Preserve FederationRegistry; add durable state, capability routing, bounded HTTP server, signed retrying client, and local integration tests.

**Tech Stack:** TypeScript, Node 22 `http`, `fetch`, HMAC SHA-256, atomic JSON persistence.

**Spec:** `docs/superpowers/specs/2026-08-30-federation-result-plane-design.md`

## Global Constraints
- TDD first.
- No remote shell/code execution.
- Durable replay/idempotency protection before acknowledgement.
- Bounded bodies and request timeouts.
- No TLS identity claims.

### Task 1: Durable federation state and router
**Files:** create `packages/federation/src/state.ts`, `packages/federation/src/types.ts`, `packages/federation/src/router.ts`; modify `packages/federation/src/index.ts`; test `tests/federation-state.test.ts`.
- [ ] Write persistence/replay/router tests and confirm RED.
- [ ] Implement minimal state/router and verify GREEN.

### Task 2: HTTP server/client
**Files:** create `packages/federation/src/transport.ts`; modify `packages/federation/src/index.ts`; test `tests/federation-transport.test.ts`.
- [ ] Write real localhost task/result/retry/tamper/expiry tests and confirm RED.
- [ ] Implement bounded signed transport and verify GREEN.

### Task 3: Integration/recovery
**Files:** test `tests/federation-integration.test.ts`.
- [ ] Test two-node round-trip, idempotent duplicate delivery, restart replay rejection, wrong recipient, and capability routing.
- [ ] Fix only verified defects.
- [ ] Run branch CI, PR CI, squash merge, fresh main CI.