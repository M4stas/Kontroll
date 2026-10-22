# S3 C: Warm worker profile

Status: implementation and offline verification complete in [PR #55](https://github.com/M4stas/kontroll/pull/55). The five-job live smoke check and both benchmark repeats are complete. Warm reuse remains opt-in because the performance target was not met. The default tests and live off-switch check are complete.

Authority: [identity integration plan, checkpoint C](../plans/2026-10-21-chromium-identity-integration.md#checkpoint-c-warm-worker-profile-with-automatic-reset), [development agent policy](../../agent-policy.md).

## What you will see

With `CHROMIUM_WARM_PROFILE=true`, each worker keeps one Chromium profile between listing jobs. The browser still starts and closes for every job. Registration number and VIN results arrive after the listing completes. Worker logs show profile job counts and reset reasons, never revealed values. CAPTCHA challenges can still appear.

## How to check

1. Set `CHROMIUM_WARM_PROFILE=true` for the warm-profile check, then start the stack from this branch using the [local development instructions](../../local-development.md).
2. Submit five supplied listings one after another. Watch the registration number and VIN settle, then check for `profile_jobs=1` through `profile_jobs=5` in the worker log.
3. Follow the plan's [six live check steps](../plans/2026-10-21-chromium-identity-integration.md#checkpoint-c-warm-worker-profile-with-automatic-reset) for the benchmark and `CHROMIUM_WARM_PROFILE=false` check. These live lookups require authorization.

## Recovery changes

Chromium cleanup always attempts the Xvfb wait, Playwright stop, disposable-profile removal and profile-lock release. A cleanup exception cannot replace the original capture failure. Fault-injection tests reproduce the old stuck-worker mechanism and require five subsequent captures to succeed after the injected shutdown failure.

The worker and saved-profile benchmark share the reset policy. Resets occur after blocks, launch errors, a failed reveal with no valued identity, two consecutive temporary capture failures, 30 jobs or 10 hours. A reset advances the profile generation even when deletion fails. Retry sessions always use a fresh profile.

The supported deployment has one sequential worker process as PID1 per Compose container, with a private temporary directory. Multiple workers in one shared temporary directory are not supported.

## Offline evidence on Mac ARM64

| Check | Result |
| --- | --- |
| Complete sandbox Python suite | 688 passed, 3 skipped |
| Chromium subset | 93 passed; one Xvfb launch failure passed on its unchanged focused rerun |
| Offline Chromium network sandbox | PASS, contacted hosts: none |
| Independent final code review | No Critical or Important findings for the supported Compose deployment |

The Chromium failure occurred before the scenario started: `test_reveals_both_values_and_records_extension_rounds` reported a missing X server. It passed unchanged in 3.22 seconds. The execution logs retain the initial failure.

Network evidence: `sandbox-reports/offline-20261022T102321Z/summary.txt`. Detailed local logs: `/tmp/s3c-finish-offline-report.md`, `/tmp/s3c-final-review.md` and `/tmp/s3c-cleanup-finish-report.md`.

## Live smoke check

The rebuilt worker completed five sequential listing jobs and revealed both identity fields on each. The profile count reached 1 through 5 with no reset. Reveal time after listing completion was 21.8, 8.1, 12.1, 59.8 and 8.1 seconds. These results do not establish the planned sub-five-second improvement.

## Benchmark repeat 1

Revision `56edb44`, Mac ARM64, 30 measured lookups per mode. Mean capture time includes every capture record, including skipped and expired listings. One expired listing counts against both first-attempt scores.

| Mode | First-attempt successes | Retry successes | CAPTCHA-free reveals | Mean capture time |
| --- | --- | --- | --- | --- |
| Fresh | 27/30 | 2 | 0 | 21.41 s |
| Warm | 25/30 | 4 | 0 | 19.39 s |

Fresh passed the 80% gate. Saved-profile mode is reported, not gated. Both modes completed every available measured listing, with one `listing_gone` capture error each. The warm run continued after four retries and reset its profile at the 30-job count limit. No repeated capture-error chain occurred.

Report: `benchmarks/s3c-finish-r1-20261022T102712Z/report.json`.

## Benchmark repeat 2

Same revision and listing set, 30 measured lookups per mode.

| Mode | First-attempt successes | Retry successes | CAPTCHA-free reveals | Mean capture time |
| --- | --- | --- | --- | --- |
| Fresh | 26/30 | 3 | 0 | 23.64 s |
| Warm | 24/30 | 5 | 0 | 21.30 s |

Fresh passed the 80% gate again. Both modes completed all available measured listings and each reported the same one `listing_gone` capture error. The warm run continued after timeout and round-limit retries, with no repeated capture-error chain.

Report: `benchmarks/s3c-finish-r2-20261022T104956Z/report.json`.

## Default decision

Fresh profiles remain the default. Warm reuse is available with `CHROMIUM_WARM_PROFILE=true`.

Across both repeats, fresh profiles had 53/60 first-attempt successes and 5 retry successes; warm profiles had 49/60 and 9 retry successes. Both modes had zero CAPTCHA-free reveals. Mean capture time was about 22.53 seconds fresh and 20.35 seconds warm. The roughly 10% timing improvement does not establish the planned sub-five-second, mostly CAPTCHA-free behavior and comes with more retries. No new reset heuristic is introduced to chase this result.

The recovery fixes remain active with either setting. The benchmark explicitly selects fresh and saved modes, so its comparison is independent of the worker's default setting.

## Final default and off-switch verification

The worker and Compose test files passed all 80 tests after changing the default to fresh profiles. Both unset and explicit false use fresh profiles; explicit true enables reuse. Independent review of the final default change found no Critical or Important findings.

The rebuilt worker was healthy with `CHROMIUM_WARM_PROFILE=false`. Live jobs completed without `profile_jobs` or `profile_reset` logs. The first identity reveal finished after the storage deadline and was rejected; the second settled as unavailable. A third supplied listing revealed both fields successfully: listing completion at 4.1 seconds, identity settled at 56.7 seconds, or 52.6 seconds after completion. The first two attempts remain recorded identity misses. The off-switch behavior itself passed: capture continued using fresh sessions without kept-profile logging.

The full offline and benchmark evidence above predates only the final default change. Explicit benchmark mode selection is independent of that default. S4 is outside this work. Stop at this checkpoint before starting further implementation.
