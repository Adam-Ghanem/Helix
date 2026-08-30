# Durable Learning and Quality Flywheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable evidence-driven learning and real bounded coding quality gates.

**Architecture:** Persist trajectories/patterns/feedback/distilled strategies in `packages/learning`; add structured verification/model gates in `packages/coding`; inject learning into `CodingHarness`; wire optional real gates into CLI without weakening existing deterministic fallback.

**Tech Stack:** TypeScript, Node 22, atomic JSON persistence, existing BoundedProcessRunner, OpenAI-compatible HTTP chat completions.

**Spec:** `docs/superpowers/specs/2026-08-30-learning-quality-flywheel-design.md`

## Global Constraints
- Tests first.
- No shell strings for verification.
- Model gates cannot overrule authoritative failed tests.
- Learning remains advisory and non-critical.
- No neural-training claims.

### Task 1: Durable Learning Engine
**Files:** modify `packages/learning/src/index.ts`; test `tests/learning-durable.test.ts`.
- [ ] Write tests for persistence, feedback ranking, distill, consolidate, bounded trajectory history.
- [ ] Run CI and confirm RED.
- [ ] Implement `DurableLearningEngine` and related types while preserving `LearningEngine`.
- [ ] Run full verification.

### Task 2: Real Quality Gates
**Files:** create `packages/coding/src/quality.ts`; modify `packages/coding/src/index.ts`; test `tests/coding-quality.test.ts`.
- [ ] Write tests for bounded verification, HTTP quality model, reviewer/judge valid/invalid JSON.
- [ ] Confirm RED.
- [ ] Implement minimal structured quality components.
- [ ] Run full verification.

### Task 3: Harness Learning Integration
**Files:** modify `packages/coding/src/harness.ts`; test `tests/coding-learning.test.ts`.
- [ ] Test terminal trajectory recording and non-critical learning failures.
- [ ] Confirm RED.
- [ ] Add optional async learning sink and trajectory generation.
- [ ] Run full verification.

### Task 4: CLI Wiring
**Files:** modify `apps/cli/src/index.ts`; extend `tests/cli-code.test.ts`.
- [ ] Test `HELIX_CODE_VERIFY_JSON` structured verification and durable learning state creation.
- [ ] Confirm RED.
- [ ] Wire VerificationRunner, DurableLearningEngine, and optional HTTP model reviewer/judge.
- [ ] Run branch CI, PR CI, squash merge, then fresh main CI.