# Completed work log

Completed implementation and historical verification results, moved out of the [main roadmap](roadmap.md) and [service roadmap](service-roadmap.md) on 2026-11-02. PR states were checked against GitHub on that date.

An implementation entry does not sign off missing checkpoint checks. The roadmaps retain those checks and all unfinished implementation. Older plans and evidence are indexed in the [archive](archive/README.md). Historical check results below are not new test runs.

For future checkpoint completions, follow [checking a checkpoint](../../AGENTS.md#checking-a-checkpoint). The checkpoint PR carries the roadmap and log changes together.

The [2026-11-02 completion audit](checkpoints/2026-11-02-checkpoints-10-12-audit.md) confirmed the implementation for checkpoints 10 to 12. Fresh focused tests passed on main and the checkpoint 12 branch, and main's production build passed. The audit signed off no checkpoint. Checkpoints 10 and 11 passed their [live checks](#checkpoints-10-and-11-live-checks) on 2026-11-03, and [checkpoint 12](#checkpoint-12-background-check-in-the-findings) passed on 2026-11-03.

## Archived app work

| Checkpoint | Completed work | PRs | Evidence |
| --- | --- | --- | --- |
| Before the redesign | Photo preparation timings in Live diagnostics | #22 | [Checkpoint](archive/photo-preparation-timings/checkpoint.md) |
| 1 to 6 | Redesign, including listing pages, report cards, the full report, review step and phone layouts | #23, #24, #26, #27, #29, #31, #32, #33 | [Redesign archive](archive/redesign/) |
| 7 | Auto24 capture timings in Live diagnostics | #46 | [Checkpoint](archive/auto24-capture-timings/checkpoint.md) |
| 8 and 9 | Save reports on the device and open them offline | #37, #40 | [Offline reports archive](archive/offline-reports/) |

## App implementation

| Checkpoint | Completed work | PR | Evidence |
| --- | --- | --- | --- |
| 10, S3 B | Show registration number and VIN on the listing page, poll pending identity values, gate the report button and add the values to report facts | #52, [#91](https://github.com/M4stas/kontroll/pull/91) | [Identity plan](plans/2026-10-21-chromium-identity-integration.md#checkpoint-b-reg-number-and-vin-on-the-listing-page), [live checks](#checkpoints-10-and-11-live-checks) |
| 11, S4 B | Start one background check alongside the review, show progress and a protected PDF link, and list the PDF as a source | #57, [#91](https://github.com/M4stas/kontroll/pull/91) | [Background check plan](plans/2026-10-22-transpordiamet-background-check.md#checkpoint-11-background-check-starts-with-the-review), [live checks](#checkpoints-10-and-11-live-checks) |
| 12, S4 C | The final assessment waits for the fetched PDF and uses it, with a finding when its VIN differs from the listing's and a reason when there is no PDF | [#93](https://github.com/M4stas/kontroll/pull/93) | [Background check plan](plans/2026-10-22-transpordiamet-background-check.md#checkpoint-12-background-check-in-the-findings), [live checks](#checkpoint-12-background-check-in-the-findings) |

Checkpoint 10's synthetic browser checks covered pending and final identity values, missing VIN, legacy jobs, expiry, and English and Estonian rendering. Independent review was clean. The PR recorded 94 test files and 953 tests passing, plus typecheck and lint. It did not run live captures or the live report check.

### Checkpoints 10 and 11 live checks

The user ran these checks on 2026-11-03 in the app started from main at `3b851f3`, with live Auto24 and Transpordiamet lookups, and confirmed both checkpoints. The user chose to run them instead of the delivering agent. [#91](https://github.com/M4stas/kontroll/pull/91) records the result.

- Checkpoint 10 used the [identity plan's steps](plans/2026-10-21-chromium-identity-integration.md#checkpoint-b-reg-number-and-vin-on-the-listing-page). The revealed values appeared on the listing and in the report facts, and a listing without a VIN showed it as missing.
- Checkpoint 11 used the steps below. The PDF matched the listing, and with `worker-mnt` stopped the line read "Unavailable" while the report finished.
- `worker-mnt` logged `background_check=fetched engine=invisible` twice. `worker-auto24`, with `CHROMIUM_LOOKUPS=false`, logged no lookup.

### Checkpoint 11: Background check starts with the review

See the [spec](specs/2026-10-22-transpordiamet-background-check-design.md) and [plan](plans/2026-10-22-transpordiamet-background-check.md#checkpoint-11-background-check-starts-with-the-review).

#### What you will see

The report button on the listing page stays disabled until both identity rows settle. Pressing it opens the report and starts the background check. The progress screen has a "Transpordiamet background check" line that pulses while the lookup runs. Then it shows "PDF ready" with a link that opens the taustakontroll PDF, or "Not in the register", "No reg number or VIN to search with" or "Unavailable" with a short reason. The full report's sources list the PDF. [Checkpoint 12](#checkpoint-12-background-check-in-the-findings) adds its use in findings.

#### How to check

1. Start the Auto24 stack with S4 A, the app and the worker, as described in [local development](../local-development.md).
2. Submit an Auto24 listing with hidden identity values. The report button stays disabled until both the reg number and VIN rows settle.
3. Press the report button. The background check line pulses, then shows "PDF ready".
4. Open the PDF from the line. It shows the same reg number, VIN and make as the listing.
5. Open "Full report". The sources list the fetched PDF with its date.
6. Reload the report and open "Full report". The background check line shows only on the progress screen, so check the sources instead. They list the same PDF with the same date, and the worker logs show no second lookup.
7. With `CHROMIUM_LOOKUPS=false`, stop `worker-mnt` before pressing the report button on a fresh listing. Keep polling through the [worker availability grace period](specs/2026-10-22-transpordiamet-background-check-design.md#lookup-availability-and-deadlines). The line reads "Unavailable", and the rest of the report finishes. Restart `worker-mnt` afterwards.
8. Open a report made before this checkpoint. It has no background check line and works as before.
9. Repeat in Estonian, in dark mode and at 390px.

### Checkpoint 12: Background check in the findings

#### What you will see

The photo and text review runs while the lookup runs. The final assessment waits for the PDF and then runs once with it, so findings can cite the PDF, for example an inspection date or an open recall. When the PDF's VIN differs from the listing's VIN, the report has a finding that says so. When there is no PDF, the report says why, and the add-evidence row still accepts a PDF you upload by hand.

#### How to check

1. Submit an Auto24 listing and press the report button. The progress screen shows the review waiting for the background check before "Write review" starts.
2. When the report finishes, at least one finding cites the fetched PDF. Live diagnostics, with `LIVE_DIAGNOSTICS_ENABLED=true`, shows exactly one final assessment.
3. Run the test that gives the reviewer a fetched PDF whose VIN differs from the listing's. The report shows the VIN mismatch finding. A real mismatched listing is not needed.
4. Upload a generated test PDF by hand on a report that already has a fetched PDF. Both show in the sources.
5. With `CHROMIUM_LOOKUPS=false`, stop `worker-mnt` before pressing the report button on a fresh listing. Keep polling through the [worker availability grace period](specs/2026-10-22-transpordiamet-background-check-design.md#lookup-availability-and-deadlines). The final assessment runs without the PDF, and the report says the background check was unavailable. Restart `worker-mnt` afterwards.
6. Repeat in Estonian.

#### Check results

The delivering agent ran these on 2026-11-03 in the internal browser, with live Auto24 and Transpordiamet lookups, from the checkpoint branch with the migration applied to the shared local database. [#93](https://github.com/M4stas/kontroll/pull/93) records the result.

1. Pass. The progress screen showed "Waiting for the background check" before "Write review".
2. Pass. A finding cited the fetched PDF's inspection date and odometer reading, and Live diagnostics showed one final assessment.
3. Pass as a unit test, in English and Estonian. The check runs no report page.
4. Pass. The fetched PDF and the upload both show in the sources. This check found the upload labelled "Listing source", so this PR adds "Seller document" and "Seller reply".
5. Pass. The report finished without the PDF and read "Unavailable (Browser stopped)", the designed result when no lookup worker sends a heartbeat for 20 seconds.
6. Pass for the interface. Findings written in Estonian were not checked, because that report started from `/en`.

Limits of these results:

- Codex was over its usage limit, so a local stand-in answered the reviewer's calls with Claude Haiku. This verifies the flow, not review quality, and needs no repeat for sign-off. The human model review stays in the [main roadmap](roadmap.md).
- Haiku often returned invalid output and retried. One report with no PDF stopped at 11 of 12 photos with no final assessment.
- Three capture reveals stalled with no CAPTCHA rounds until the workers restarted. The capture code did not change, and the cause is unknown.
- The 2026-11-03 integration run passed 106 of 108 tests. One test in each of `tests/integration/diagnostics-access.test.ts` and `tests/integration/durable-review-pipeline.test.ts` also failed on main's code, one of them intermittently. After the review fixes, the author recorded 1,174 unit tests passing and 116 of 117 integration tests passing at `b5f4590`, against a disposable Supabase stack. The remaining failure in `tests/integration/diagnostics-access.test.ts` also fails on main. The user skipped the pipeline Test step after its offline dependency installation stalled; these results do not verify later rebased commits.

## Service implementation

The following entries preserve the implementation status and evidence recorded when the work moved out of the service roadmap. Any remaining checks listed here are tracked as active work in the roadmaps.

| # | Completed implementation | Visible result | Recorded status | Source |
| --- | --- | --- | --- | --- |
| S1 | Registration number and VIN in the extraction result | The full registration number and VIN with their status in the extraction API docs page, and the solve record in the job | Merged in #35. The last Camoufox live gate failed at 3 of 10 on attempt 1; Chromium later became the default in #54. This historical failure no longer blocks the S3 app integration. See [evidence](checkpoints/2026-10-12-registration-reveal-s1.md#premerge-fix-results). | [Plan](plans/2026-10-11-auto24-registration-reveal-s1.md), [spec](specs/2026-10-11-auto24-registration-reveal-design.md) |
| S2 | Chromium capture engine with the local CaptchaRaptor extension | C1: a Chromium job returns the same facts as Camoufox, with `engine: chromium` and `extension_loaded: true`. C2: the revealed values with `solver: extension`, and an engine benchmark | Merged to main in #49. Offline checks passed on ARM64, and Chromium passed 3 Mac live runs. The checkpoint still lists open live API checks and the 3-run replacement gate on the `x86_64` server. See [checkpoint](checkpoints/2026-10-19-chromium-engine.md). | [Spec](specs/2026-10-19-chromium-extension-engine-design.md), [plan](plans/2026-10-19-chromium-extension-engine.md) |
| S3 | Chromium in production, identity on the listing page, warm worker profile | A: jobs complete in seconds and the reg number and VIN fill in afterwards, on the default Chromium worker. B: the reg number and VIN on the listing page and in the report facts. C: opt-in profile reuse with automatic resets; fresh profiles stay the default | A merged in #54 and passed its live checks. B merged in #52, and its live app checks passed on 2026-11-03 as main checkpoint 10. C merged in #55; both live benchmark repeats and the off-switch check completed. Warm reuse stays opt-in because the performance target was not met; identity misses are recorded in the [evidence](checkpoints/2026-10-22-s3-c-warm-profile.md). | [Plan](plans/2026-10-21-chromium-identity-integration.md) |
| S4 | Transpordiamet background check | A: a background check route that fetches the taustakontroll PDF with the job's reg number or VIN. B and C are main roadmap checkpoints 11 and 12: the lookup starts with the review, and the findings use the PDF | A merged in #58, with the reCAPTCHA fix in #59. Two Mac lookups fetched PDFs; Task 6's server benchmark and live checks remain open. B merged in #57. Main checkpoints 11 and 12 passed their live app checks on 2026-11-03. S5 supplies the current lookup worker. See [evidence](checkpoints/2026-10-22-s4-a-background-check.md). | [Spec](specs/2026-10-22-transpordiamet-background-check-design.md), [plan](plans/2026-10-22-transpordiamet-background-check.md) |
| S5 | Background check on invisible_playwright | The default lookup-only `worker-mnt` fetches the taustakontroll PDF; Chromium captures listings and only takes lookups with `CHROMIUM_LOOKUPS=true` | Merged in #73, then made the default in #74. The service live check fetched 8 of 8 PDFs, median 10.2 s, with the final guard fixes. Those live runs bypassed the storage queue. The queued app checks passed on 2026-11-03 with checkpoint 11, and the Chromium opt-in check remains open. See [evidence](checkpoints/2026-10-29-s5-invisible-lookup.md). | [Plan](plans/2026-10-29-invisible-mnt-lookup-engine.md) |

### Completed S1 preparation

- The CAPTCHA and hidden-control references in the Auto24 service design were updated to point to the registration reveal spec.
- The merged implementation uses pinned solver files; their provenance is recorded in the [S1 evidence](checkpoints/2026-10-12-registration-reveal-s1.md).
- The recon capture of listing 4341713 was completed. Test pages replaced real values, keys, tokens and cookies with made-up ones. Findings are in the [registration reveal spec](specs/2026-10-11-auto24-registration-reveal-design.md).

### Implementation evidence (2026-10-22)

- Tasks 7 to 10 are implemented on `codex/background-check-report`, from `origin/main` after PR #56 merged. The service files are untouched.
- TDD covers service states and refusals, the 240-second deadline, PDF validation and integrity, one lookup per analysis, deferred work, authenticated downloads, translations and old reports.
- `pnpm test --maxWorkers=2`: 101 files and 1,043 tests pass. `pnpm typecheck` and `pnpm lint` pass. Commands use `--config.verify-deps-before-run=false` to reuse installed dependencies without automatic installation in the worktree.
- PostgreSQL checks run the migration, synthetic regressions and rollback inside one transaction. Duplicate requests, manual entry, deferral attempts and timing, private access, and seller replies or PDF uploads during a lookup pass. The transaction is rolled back.
- Independent review is clean after fixes for the plain worker runtime, infrastructure retries, supplement lifetime and refused starts.
- Internal-browser checks pass at 1280px and 390 CSS pixels, in English and Estonian, light and dark, for pending progress and the PDF-ready link. The full report lists the fetch date; its protected link downloads the generated PDF. The test-only preview selects the existing color-scheme CSS rules because the internal browser has no theme emulation control.
- No live lookups, captures or benchmarks were run for this implementation evidence on 2026-10-22. Later service checks are recorded in the [S4 A evidence](checkpoints/2026-10-22-s4-a-background-check.md#first-live-check-2026-10-23); the live app checks passed in [checkpoint 11](#checkpoint-11-background-check-starts-with-the-review).

## Numbering history

Main checkpoints 1 to 6 cover the redesign, 7 covers Auto24 capture timings, and 8 and 9 cover offline reports. Checkpoint 10 was S3 B. Checkpoints 11 and 12 are S4 B and C. Checkpoints 13 to 15 were A1 to A3 in the registration reveal spec. Checkpoints 16 to 19 were numbered 14 to 17 before checkpoints 11 and 12 were added on 2026-10-22. Source plans retain their original numbering.
