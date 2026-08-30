# Helix Durable Learning and Quality Flywheel Design

## Goal

Turn Helix learning from an in-memory score table into a durable evidence-driven flywheel and replace placeholder coding quality gates with bounded verification plus structured reviewer/judge implementations.

## Architecture

The tranche has two connected units.

1. `packages/learning` becomes durable while preserving the existing `LearningEngine` API. A new `DurableLearningEngine` persists trajectories, patterns, explicit feedback, distilled strategies, and consolidation metadata. It supports retrieve -> judge/feedback -> distill -> consolidate as transparent data operations; it does not claim neural fine-tuning.
2. `packages/coding/quality.ts` adds a bounded `VerificationRunner`, a provider-neutral `QualityModel`, an OpenAI-compatible HTTP implementation, structured `ModelReviewer`, and structured `ModelJudge`. `CodingHarness` can emit trajectories into a learning sink after terminal attempts.

## Durable Learning Contracts

- `DurableLearningEngine({ stateFile, maxTrajectories?, halfLifeDays? })`
- `init()` restores state.
- `record(trajectory)` persists the trajectory and updates patterns.
- `feedback({ patternId, accepted, quality, note? })` updates explicit judge/human evidence without rewriting trajectory history.
- `recommend(taskType, { limit? })` ranks by learned score, feedback score, recency decay, and sample confidence.
- `distill(taskType)` creates or updates a `DistilledStrategy` from the highest-evidence successful patterns and recurring failed patterns.
- `consolidate({ now? })` applies decay, prunes stale low-evidence patterns, bounds retained trajectories, and keeps distilled strategies linked to surviving evidence.
- All writes use serialized atomic replacement.

## Quality Contracts

`VerificationRunner` consumes structured commands only:

```ts
{ executable: string; args: string[]; cwd?: string; name?: string }
```

It uses `BoundedProcessRunner`, never a shell command string, and returns a `TestVerdict`. Any non-zero exit, timeout, cancellation, or runner error fails the verdict.

`QualityModel` is provider-neutral:

```ts
complete({ system, prompt, timeoutMs }): Promise<string>
```

`HttpQualityModel` calls an OpenAI-compatible `/chat/completions` endpoint with bounded timeout/output parsing.

`ModelReviewer` and `ModelJudge` request strict JSON and validate/clamp the response. Invalid model JSON is a failed/rejected gate, not silent acceptance.

## Harness Integration

`CodingHarness` accepts optional `learning` with an async-compatible `record(Trajectory)` method. Every completed/failed quality-gated attempt records a trajectory using adapter, review, test, judge, cost/latency evidence. Learning failures remain non-critical and are stored as optional failure evidence.

## CLI Integration

- `HELIX_CODE_VERIFY_JSON` configures structured verification commands.
- When verification commands are configured, CLI uses `VerificationRunner`; otherwise the explicit summary states no verification commands were configured.
- When `HELIX_QUALITY_MODEL_API_URL`, `HELIX_QUALITY_MODEL_API_KEY`, and `HELIX_QUALITY_MODEL` are configured, CLI uses `HttpQualityModel` reviewer/judge; otherwise deterministic structural reviewer/judge remain available and are labeled as such.
- Durable learning state lives at `.helix/learning.json` and is injected into coding harness runs.

## Safety

- No `shell: true`.
- Verification executable/cwd are bounded by configured allowlists/workspace roots.
- Model output cannot override failed authoritative tests.
- Learning is advisory; learned strategies do not bypass policy or quality gates.
- No claims of LoRA/EWC/neural training.

## Verification

TDD tests cover restart persistence, feedback ranking, distillation, consolidation, bounded verification, HTTP quality model parsing, invalid reviewer/judge JSON rejection, harness learning integration, and CLI configured verification.