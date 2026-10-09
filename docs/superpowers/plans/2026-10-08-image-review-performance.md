# Image review performance plan

> Execute in this chat with an implementation agent, independent review, and end-to-end validation.

Goal: reduce the time spent reviewing multiple images without changing the reviewer model, reasoning effort, prompts, image resolution, evidence rules, or public API.

Scope: use the isolated `codex/image-review-performance` checkout. Auto24 and existing analyses remain unchanged. Agent policy remains read-only; refer to [the development agent policy](../../agent-policy.md).

## Baseline and design

The current coordinator awaits text, then each selected image, then final review. Local audit records show 221 successful Luna xhigh image attempts longer than one second, averaging 32.02 seconds. These historical records are context, not a paired benchmark.

Keep text first. Run at most three image tasks at a time. Each task keeps its own capability, execution, attempt, and durable result. Serialize immutable progress snapshots. Collect results by manifest index, then pass text and images in manifest order to final review. On infrastructure failure, stop scheduling new images and await all already-running work before returning, so lease renewal remains active. Model warnings remain retryable through the existing mechanism.

## Work

- [x] Establish the existing test baseline with `npm test -- --reporter=dot`.
- [x] Add failing coordinator tests for a three-task limit, out-of-order completion, serialized progress, partial failure, cache reuse, and waiting for sibling tasks after infrastructure failure.
- [x] Implement bounded image concurrency in `src/analysis/review-coordinator.ts` and run the focused tests.
- [x] Add a reproducible benchmark that compares the baseline coordinator with the candidate on identical review inputs. Separate deterministic scheduling measurements from live model measurements.
- [x] Run the unit suite, typecheck, lint, and relevant database integration tests. Verify final publication waits for every durable image result and retries reuse completed images.
- [x] Test the duplicate application through the browser for per-image progress and final completion. Fix any regression and repeat the affected checks.
- [x] Obtain an independent subagent review, fix findings, and open a PR with measured results and limitations.

Acceptance: concurrency never exceeds three within one review; final input order remains deterministic; progress never moves backward; an infrastructure error leaves no detached image work; no changes to model or image quality; independent review and e2e testing are clean.
