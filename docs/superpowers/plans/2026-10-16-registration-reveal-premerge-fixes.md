# Registration reveal premerge fixes implementation plan

> **For agentic workers:** Use `subagent-driven-development` or `executing-plans` task by task. Read the linked spec and [development agent policy](../../agent-policy.md) before assigning agents. Stop at each checkpoint for the user's acceptance.

**Goal:** First prove that the service retrieves valid VIN and registration values from the user's supplied Auto24 links, then integrate those values into the current main app before merging PR #35.

**Architecture:** Keep the existing Python solver, request guard, asynchronous job API, and lease. Bound stalled stages, preserve retry time, and fix dynamic image replacement tracking. Only after the service checkpoint passes and the user approves, carry its validated values through the existing TypeScript capture, normalization, and report flow.

**Tech stack:** Python, synchronous Playwright/Camoufox, ONNX, Docker Compose, TypeScript, Zod, Next.js, Vitest.

**Spec:** [Registration reveal design](../specs/2026-10-11-auto24-registration-reveal-design.md), narrowed to the confirmed bugs and existing app integration. [Handoff](../checkpoints/2026-10-12-registration-reveal-s1.md#handoff) provides historical evidence. This plan was prepared with Astra low.

**Execution status, October 16:** Checkpoint 1 fixes are implemented and reviewed. All 426 Python tests passed, but the primary live gate failed at 3 of 10 on attempt one, with 3 additional recoveries through retry. The failed-gate stop applies. Checkpoint 2 has not started. See [current evidence](../checkpoints/2026-10-12-registration-reveal-s1.md#premerge-fix-results) before resuming.

## Global constraints

- Checkpoint 1 implementation and its requested live benchmark were approved on October 16. Checkpoint 2 and merging are not approved.
- The user's October 16 instruction explicitly orders service proof on their supplied links before app integration. It supersedes the handoff's older user-only benchmark rule for the requested benchmark after checkpoint approval.
- Keep real identifiers, tokens, cookies, response bodies and secrets out of the repository, commits, reports, logs, and chat. Compare actual values privately in the running service and listing. Debug screenshots still contain listing content and must remain local and ignored.
- Keep outbound traffic restricted to Auto24 and the existing Google/gstatic reCAPTCHA paths. Use only the pinned solver data, no third-party extension code or new dependencies.
- Keep the three-round limit, 120-second lease, and 15-second completion margin. Existing field validation and DOM/Auto24 JSON agreement remain mandatory.
- Python tests run in Docker with source mounted read-only and networking disabled. Rebuild from this worktree first. Use the internal browser for supported manual checks; do not use Firefox for manual testing.
- Preserve unrelated local changes. Ask before pushing, do not merge automatically, and do not delete remote branches. Update the existing PR rather than open a competing PR.
- Allocation rules remain in the policy, not this plan. Use independent subagent review and manual frontend E2E for implemented frontend changes.

## Checkpoint 1: Reliable service reveal on the supplied live links

### Before starting

- [ ] Fetch current `main` and verify the exact PR head and worktree status. At planning time, GitHub PR head is `e0ea817`, main is `b97168d`, and local `8477bbf` adds documentation only. Main is already included. Repeat the check before implementation rather than relying on these hashes.
- [ ] Read the spec, handoff, and policy. Preserve existing docs-only changes. Keep all app integration out of this checkpoint.
- [ ] Record the supplied URL cohort from `benchmarks/urls.txt` without substituting other listings. The previous run encountered one expired listing. Report unavailable links explicitly; do not describe them as successful reveals.
- [ ] Capture the starting revision, solver hashes and benchmark policy. The prior baseline passed 8/10 but stalled for 85.2 and 89.9 seconds and exercised no 4x4 rounds. It is not proof of the fixes.

### What you will see

In the running service API docs at `http://localhost:8000/docs`, live jobs return the VIN and registration value with their statuses when Auto24 provides them. A stalled reveal ends sooner and can retry in a fresh session. If VIN fails after registration succeeds, the successful registration stays available. Base listing capture still completes when reveal fails.

### Task 1: Bound stalled stages and preserve retry time

**Files:** `src/auto24_service/captcha/recaptcha.py`, `src/auto24_service/captcha/reveal.py`, `src/auto24_service/browser.py`; `tests/test_captcha_driver.py`, `tests/test_reveal.py`, `tests/test_browser.py`, `tests/test_worker.py`, and fake-site fixtures.

**Interfaces:** Preserve `capture_listing(..., deadline: float | None)` and `reveal_registration(..., deadline: float | None)`. All budgets use the same monotonic clock. Keep existing reason/stage vocabulary unless a validated additive change is necessary.

- [ ] Add regression tests before changing production code. Cover silent checkbox, silent verification, a stuck reveal trigger, meaningful progress, slow initial navigation, insufficient time for retry, and a successful registration followed by a VIN timeout. Use injected clocks or short test budgets where possible rather than adding 20-second waits to every test.
- [ ] Start with a 20-second no-progress limit for checkbox state and verification. Give trigger/widget/value appearance a bounded stage wait as well. Only meaningful changes reset inactivity, such as a new challenge, tile identity, checked state or validated field response. Repeated polls and unchanged replies do not reset it.
- [ ] Cap nested controllable Playwright waits by the minimum of stage, attempt, and capture deadlines. Do not claim a timer alone can interrupt an unresponsive synchronous browser process.
- [ ] Compute attempt one's budget after initial browser opening/navigation, reserving 30 seconds for a useful second attempt, the existing five-second join allowance, and a one-second scheduling/handoff margin. Share these constants with the second-attempt calculation and test full first-budget expiry with nonzero bookkeeping overhead:

```python
first_budget = min(90.0, deadline - clock() - 36.0)
```

- [ ] When the reserve would leave less than the existing minimum first-attempt budget, use the remaining capture budget for one bounded attempt. Do not skip all useful work merely to reserve an impossible retry. Recompute the second budget at its actual start. Keep the 15-second lease margin untouched.
- [ ] Pass the capture deadline into controllable launch/navigation waits using a backward-compatible optional argument to `open_listing`. Include elapsed navigation, retry launch, join, and shutdown in boundary tests. Record the remaining uninterruptible-call limitation instead of expanding into a new process supervisor.
- [ ] Retain completed fields in `revealed`, retry only missing fields, and preserve DOM/JSON agreement and prefix validation. The existing code already retains partial successes; add the specific VIN-timeout regression rather than replacing that behavior.
- [ ] Run each new failing test on the old implementation, then rerun it and the existing affected tests after the minimal fix.

### Task 2: Process replacement tiles from their pre-click identities

**Files:** `src/auto24_service/captcha/recaptcha.py`, `tests/test_captcha_driver.py`, `tests/fakesite/__init__.py`, `tests/fakesite/pages/bframe.html`.

**Interface:** Pass pre-click tile sources into the refill routine rather than capturing them afterward:

```python
solve_refills(tiles, pending_sources: dict[int, str], label: str, record: dict) -> None
```

- [ ] Extend fake scenarios to exercise immediate, staggered, unloaded, and missing replacements. Assert the image bytes received by the stub solver and the clicked tile identities.
- [ ] Snapshot each selected tile immediately before clicking, both initially and for every refill generation. A replacement arriving during subsequent click delays must already qualify as new.
- [ ] Require a changed image source and loaded image evidence, `complete` with positive `naturalWidth`, before classification. Preserve the bounded six-second replacement wait within the overall deadlines.
- [ ] On missing replacement, end with a timeout recorded at round stage `refills`. Never classify or click the unchanged image again. Cover multiple generations and the case where source changes before decoding finishes.
- [ ] Verify that ordinary 3x3, dynamic 3x3, 4x4, widget removal, token-decoy and three-round cases still pass.

### Task 3: Make build and benchmark evidence reproducible

**Files:** `docs/local-development.md`, `src/auto24_service/captcha_benchmark.py`, `tests/test_captcha_benchmark.py`, and the S1 checkpoint document.

- [ ] Fix the manual Docker command and document verified asset fetching first:

```sh
scripts/fetch-captcha-solver
docker build \
  --build-context captcha_solver="$HOME/.cache/auto24/captcha-solver/current" \
  -t auto24-extraction-service:manual .
```

- [ ] Reuse the existing benchmark report. Add only the evidence needed to assess this fix: tested revision, verified solver hashes even when the cache lacks `SHA256SUMS`, deadline policy, capture wall time, attempt duration, per-field status, grid counts, and whether retry actually started. Keep identifier values out of output.
- [ ] Distinguish a synthetic skipped retry from an executed retry. Add synthetic report fixtures for full success, partial success, expired listing, timeout, skipped retry and executed retry. Preserve the existing first-attempt gate denominator and report every capture error separately.
- [ ] Record sanitized challenge shape/source information when labels are missing. Do not change parsing or reuse old labels without evidence that the parser is responsible.

### Task 4: Offline proof and independent review

- [ ] Rebuild the Compose service image with the verified solver context, then rebuild its sandbox image. Verify the corrected manual build command too.
- [ ] Run focused regressions, followed by the full offline Python suite. Use the existing sandbox image with no network:

```sh
docker run --rm --network none -v "$PWD:/app:ro" -w /app \
  -e PYTHONPATH=/app/src:/app/tests --entrypoint python \
  auto24-extraction-service:sandbox -m pytest -q -p no:cacheprovider
scripts/network-sandbox offline
```

- [ ] Require the offline sandbox to pass with no contacted hosts. Run the existing TypeScript submission/polling/registration compatibility tests and required typecheck, lint, and unit checks. These prove current-main behavior is preserved, not that app consumption is implemented.
- [ ] Have an independent review subagent inspect the final diff, deadlines, partial success, request guard, and privacy. Fix findings and rerun affected checks before any live benchmark.

### Task 5: Authorized live benchmark on the fixed revision

- [ ] Freeze the tested revision and supplied URL file before the primary run. Run fresh mode with production lease timing and debug output. Use the rebuilt image, with no model or solver changes between samples:

```sh
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 up --build -d
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 run --rm \
  -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker \
  -m auto24_service.captcha_benchmark --mode fresh \
  --listings /app/benchmarks/urls.txt --label premerge-fixes --debug \
  --revision "$(git rev-parse HEAD)"
```

- [ ] Keep the existing ten eligible-reveal gate, at least 8/10 on attempt one within three rounds. The six supplied links may repeat as the existing runner cycles them; disclose repetitions, expired listings, and all capture errors. Do not imply ten distinct vehicles were tested or silently replace supplied links.
- [ ] Report per-field success and partial results separately. `not_listed` is not proof of retrieval. Compare stall durations, capture wall time, executed retries and retry successes with the earlier baseline. Offline controlled failures must establish the 20-second inactivity bound even if live stalls do not occur.
- [ ] Require observed 4x4 cases before calling that path validated. If none occur, allow one separately labeled supplementary run capped at ten eligible reveals on the same supplied URLs. Report it separately, never replace primary failures or keep running for a favorable score. If coverage is still absent, mark it unverified.
- [ ] If the primary gate fails, stop and return the evidence for the approach A decision. Hidden-field proof additionally requires at least one successful `revealed` result for VIN and one for registration, private user confirmation, and per-field statuses for every supplied URL. `listed_in_full`, `not_listed`, or an aggregate 8/10 score cannot substitute for that proof. If the supplied URLs cannot establish both actual retrievals, stop and report the limitation before app work.
- [ ] Save all run artifacts locally and update the checkpoint evidence. Present results and concrete fixes for review; ask separately before pushing updates to PR #35. Do not merge.

### How to check

1. Start the rebuilt service and open its API docs. Submit the provided live links and poll the returned job IDs.
2. Compare revealed VIN and registration values privately with Auto24. Check each field's status, and distinguish unavailable or absent values from successful retrieval.
3. Inspect attempt durations and confirm a failed reveal still yields a completed base listing job. Use the offline regression evidence for deterministic stall and partial-success cases.
4. Open the saved benchmark summary. Check the tested revision, all outcomes, first-attempt gate, field success counts, retry execution, expired links, and 4x4 coverage.
5. Review the evidence and approve or reject checkpoint 2. Stop here until that decision.

## Checkpoint 2: Use the proven values in the current main app

### Before starting

- [ ] Require checkpoint 1 acceptance. Fetch main again and reconcile any new changes before writing app code. Read the relevant installed Next.js guides before modifying frontend code.
- [ ] Confirm the actual captured-fact and report paths in current main. Reuse them. No photo fallback, new provider calls, report redesign, or new diagnostics subsystem belongs in this checkpoint.

### What you will see

A listing captured through the current app carries the service's validated VIN and registration number into its existing vehicle facts and report evidence. Existing payloads without registration still work. Custom plates and older chassis numbers remain available rather than disappearing during normalization. Missing values remain missing; the app never substitutes a truncated preview.

### Implementation and proof

**Files:** `src/listings/contracts.ts`, `src/listings/captured-job.ts`, `src/analysis/normalize.ts`, the existing report evidence renderer `src/features/report/evidence-disclosure.tsx` and relevant ET/EN messages only where needed. Tests: `tests/listing-registration-compat.test.ts`, `tests/captured-listing.test.ts`, `tests/create-captured-analysis.test.ts`, `tests/unit/analysis/normalize.test.ts`, and existing report evidence tests.

- [ ] Add an optional, validated registration object matching the Python contract. Accept old payloads without it. Continue dropping private solve diagnostics at the app boundary.
- [ ] Map only `revealed` and `listed_in_full` non-null values into the existing `vin` and `registration plate` facts with Auto24 provenance and the existing listing confidence. Prefer validated structured service values over truncated legacy fields; omit duplicate facts. Preserve genuine conflicts through the existing conflict mechanism rather than silently overwriting unrelated evidence.
- [ ] Also retain the validated registration object in `capturedJobSnapshot().sourceRecords[].content`. The report evidence renderer reads this serialized content, not analysis facts alone. Prefer eligible structured values there, falling back to complete legacy values for historical reports without the object.
- [ ] Extend normalization narrowly for service-valid custom plates and nonstandard VINs. Derive validation context from the matching structured registration field, its eligible status, exact value and Auto24 source identity. Pass that context through the existing normalization call chain; do not relax the global regex for arbitrary legacy text or mark all Auto24 text validated. Preserve existing standard formatting, invalid-value rejection, and conflict behavior. Include a negative test where identical nonstandard text without structured validation remains rejected. Test these values through capture, persistence, normalization and report rendering, not just a schema parse.
- [ ] Reuse the existing report evidence display and missing-VIN behavior. Add the registration row only if the existing renderer has none. Do not label scraped values as independently verified or include solve diagnostics in public report output.
- [ ] Cover old/new service payloads, full/partial/missing registration, DOM-preview fallback, duplicate/conflicting legacy facts, custom plates, older VINs, ET/EN, and saved historical reports. Replace the test that intentionally drops registration with the new accepted boundary behavior; keep diagnostics stripping covered.
- [ ] Run affected tests and required full project checks. Have an independent review subagent inspect the final app diff. Use the internal browser for manual E2E against the rebuilt service: successful reveal through report, failed reveal with base listing, old report, and both languages. Fix issues and retest before requesting acceptance.
- [ ] Refresh current-main compatibility evidence and PR description, including both checkpoint outcomes and remaining live coverage limits. Ask before pushing. PR #35 must be updated, independent review clean, and frontend manual E2E clean before declaring feature development done. Merging remains the user's decision.

### How to check

1. Run the current app and workers against the accepted service build. Submit a supplied Auto24 link proven in checkpoint 1.
2. Open its captured facts and completed report. Privately compare VIN and registration with the service result and Auto24.
3. Check a partial or unavailable result and an older saved report. Both remain usable, with no preview presented as a full identifier.
4. Check synthetic custom-plate and older-VIN fixtures, then repeat the visible report checks in Estonian and English.
5. Review the final PR evidence and decide whether it is ready to merge. Stop after this checkpoint.

## Human-only acceptance

The user compares real identifiers privately, approves each checkpoint, and makes the approach change and merge decisions. These are outside agent implementation tasks. Neither a passing benchmark nor completion of checkpoint 1 approves checkpoint 2 automatically.
