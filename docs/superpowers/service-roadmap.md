# Service roadmap

Remaining extraction service checks. Completed implementation and historical results live in the [completed work log](completed-work.md). App work is in the [main roadmap](roadmap.md).

The delivering agent runs and records each remaining check, as [checking a checkpoint](../../AGENTS.md#checking-a-checkpoint) describes. Use the current stack from [local development](../local-development.md). If a service or required input is unavailable, report the blocker and keep the check open.

| # | Remaining work | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| S2 | Verify Chromium on the server and finish live API checks | Matching listing facts and identity values in the API docs page; three passing fresh-profile benchmarks on the server | Live API checks and the server replacement gate remain open | [Checkpoint](checkpoints/2026-10-19-chromium-engine.md) |
| S4 | Finish the server background-check benchmark and live checks | A queued server lookup returns a matching PDF or the expected missing-result status | Task 6 remains open | [Background check plan](plans/2026-10-22-transpordiamet-background-check.md#task-6-benchmark-and-docs-live-runs-need-the-users-approval) |
| S5 | Verify Chromium's opt-in lookup routing | With `CHROMIUM_LOOKUPS=true`, Chromium claims lookups too | The queued app checks passed with checkpoint 11; the opt-in check remains open | [Check steps](checkpoints/2026-10-29-s5-invisible-lookup.md#how-to-check) |

## S2: Chromium capture engine

### What you will see

The API docs page shows matching listing facts, registration number and VIN from Chromium. The server benchmark reports the first-attempt success rate and how often shared sessions avoid a CAPTCHA.

### How to check

1. Complete the open C1 live API checks in the [checkpoint](checkpoints/2026-10-19-chromium-engine.md#c1-auto24-capture-on-chromium), including the network allowlist and comparison with Camoufox.
2. Complete the open C2 checks in [its C2 section](checkpoints/2026-10-19-chromium-engine.md#c2-plan-a-reveal-and-the-engine-benchmark). Compare the revealed values with the listing and run both engine benchmarks on the `x86_64` server, using the same listings file.
3. Record three consecutive passing `chromium/fresh` runs and the `chromium/shared` no-CAPTCHA count. Each engine needs its own image; `--engine both` cannot run in either image.

If the Chromium gate fails, stop and report the result before choosing another engine.

## S4: Transpordiamet background check

### What you will see

A queued background check on the server returns a matching taustakontroll PDF, or the expected status when the lookup cannot fetch one. The benchmark records lookup times and outcomes.

### How to check

1. Run Task 6's benchmark and server checks from the [background check plan](plans/2026-10-22-transpordiamet-background-check.md#task-6-benchmark-and-docs-live-runs-need-the-users-approval), using its required listings and current worker setup.
2. Record each result and any server-specific challenge or failure in the PR and checkpoint evidence.

The app lookup checks passed in [checkpoint 11](completed-work.md#checkpoint-11-background-check-starts-with-the-review). The findings implementation is on checkpoint 12's unmerged branch; its delivery and verification are tracked in the [main roadmap](roadmap.md).

## S5: Default lookup worker

The default `worker-mnt` route passed through the queued app flow with [checkpoint 11](completed-work.md#checkpoint-11-background-check-starts-with-the-review).

### What you will see

With `CHROMIUM_LOOKUPS=true`, the `worker-auto24` logs show Chromium claiming lookups.

### How to check

1. Set `CHROMIUM_LOOKUPS=true` in the stack's env file and recreate `worker-auto24`, as [local development](../local-development.md#invisible-lookup-worker) describes.
2. Request a fresh report and confirm that Chromium claims a lookup.
3. Restore `CHROMIUM_LOOKUPS=false` and recreate `worker-auto24`.
