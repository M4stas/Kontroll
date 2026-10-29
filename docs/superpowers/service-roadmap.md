# Service roadmap

Planned work on the Auto24 extraction service that is not yet implemented. Service work can proceed alongside the redesign. Finished work lives in [archive](archive/README.md).

Each checkpoint ends with a change you can see in the running service. After a checkpoint, run it, follow its check steps, and then decide whether to approve the next one. The design is in the [registration reveal spec](specs/2026-10-11-auto24-registration-reveal-design.md). Main app work that follows is in the [main roadmap](roadmap.md).

| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| S1 | Registration number and VIN in the extraction result | The full registration number and VIN with their status in the extraction API docs page, and the solve record in the job | Premerge fixes reviewed; 426 offline tests passed, latest live gate failed at 3 of 10 on attempt 1. App integration stopped. See [current evidence](checkpoints/2026-10-12-registration-reveal-s1.md#premerge-fix-results). | [Plan](plans/2026-10-11-auto24-registration-reveal-s1.md), [spec](specs/2026-10-11-auto24-registration-reveal-design.md) |
| S2 | Chromium capture engine with the local CaptchaRaptor extension | C1: a Chromium job returns the same facts as Camoufox, with `engine: chromium` and `extension_loaded: true`. C2: the revealed values with `solver: extension`, and an engine benchmark | C1 and C2 built and verified offline on ARM64. Chromium passed the first-attempt gate in 3 live runs on the Mac (10 of 10, 34 of 34, 34 of 34); the replacement rule still needs 3 runs on the `x86_64` server. See [checkpoint](checkpoints/2026-10-19-chromium-engine.md). | [Spec](specs/2026-10-19-chromium-extension-engine-design.md), [plan](plans/2026-10-19-chromium-extension-engine.md) |
| S3 | Chromium in production, identity on the listing page, warm worker profile | A: jobs complete in seconds and the reg number and VIN fill in afterwards, on the default Chromium worker. B: the reg number and VIN on the listing page and in the report facts. C: opt-in profile reuse with automatic resets; fresh profiles stay the default | A merged in #54 and passed its live checks. B merged in #52. C implemented in #55; both live benchmark repeats completed. Warm reuse is opt-in because the performance target was not met. Default tests and the live off-switch check are complete; identity misses are recorded. See [evidence](checkpoints/2026-10-22-s3-c-warm-profile.md). | [Plan](plans/2026-10-21-chromium-identity-integration.md) |
| S4 | Transpordiamet background check | A: a background check route that fetches the taustakontroll PDF with the job's reg number or VIN. B and C are main roadmap checkpoints 11 and 12: the lookup starts with the review, and the findings use the PDF | A, Tasks 1 to 5, merged in #58 on 2026-10-22 after your recon session. The first live check on 2026-10-23 found the driver pressing "Otsin" before reCAPTCHA loaded; #59 fixed it, and two live lookups from the Mac then fetched the PDF. Task 6, the benchmark and the live checks from the server, is not started. B merged in #57. C is on an unmerged local branch. See [evidence](checkpoints/2026-10-22-s4-a-background-check.md) | [Spec](specs/2026-10-22-transpordiamet-background-check-design.md), [plan](plans/2026-10-22-transpordiamet-background-check.md) |
| S5 | Background check on invisible_playwright | A lookup-only `worker-invisible` fetches the taustakontroll PDF, and `CHROMIUM_LOOKUPS=false` hands it every lookup | Tasks 1 to 5 implemented. Task 5 service tests pass, and its offline network check passes with no contacted hosts. The live check fetched 8 of 8 PDFs, median 10.2 s, with the final guard fixes. See [evidence](checkpoints/2026-10-29-s5-invisible-lookup.md) | [Plan](plans/2026-10-29-invisible-mnt-lookup-engine.md) |

## S1: Registration number and VIN in the extraction result

### Before starting

- Done: rewrite the CAPTCHA and hidden-control sentences in the [Auto24 service design](archive/auto24-service/2026-09-26-auto24-extraction-service-design.md) to point to the spec.
- Create the `captcha-solver-assets` branch from the pinned upstream commit, with user approval before pushing it.
- Done: the user saved listing 4341713 from a private Firefox window (page markup before and after the reveal, a HAR log, notes) in a folder outside the repository. Test pages built from it replace real values, keys, tokens and cookies with made-up ones. Findings are in "Auto24 reveal mechanics" in the spec.

### What you will see

In the extraction API docs page (`http://localhost:8000/docs`), a submitted listing returns the full registration number and VIN with their status, and the job includes the solve record.

### How to check

1. Run `scripts/fetch-captcha-solver` and confirm it reports all four files verified.
2. Run the offline sandbox and confirm it reports no outgoing traffic.
3. Run the live sandbox and confirm PASS with only the three allowed hosts.
4. Run the benchmark with `--mode fresh saved` on a few listings and confirm PASS for `camoufox/fresh`. (`saved` is reported, not gated.)
5. Rebuild the Auto24 stack, submit a listing with hidden values in the API docs page, and compare the returned values with the listing in your own browser.
6. Submit a listing with no registration row and confirm `not_listed` and a completed job.

If step 4 fails the gate, stop and review approach A before continuing.

## S2: Chromium capture engine

C1 and C2 are built. The C1 checks are in the [checkpoint doc](checkpoints/2026-10-19-chromium-engine.md#c1-auto24-capture-on-chromium) and the C2 checks are in [its C2 section](checkpoints/2026-10-19-chromium-engine.md#c2-plan-a-reveal-and-the-engine-benchmark). The C2 benchmark is two runs on the same listings file, one per image (`camoufox/fresh` in `worker-camoufox`, `chromium/fresh` and `chromium/shared` in `worker`). Replacing Plan B needs `chromium/fresh` to pass 3 runs in a row. If it fails the gate, decide between CloakBrowser and staying on Plan B.

## S3: Chromium in production and identity on the listing page

Planned in [the identity integration plan](plans/2026-10-21-chromium-identity-integration.md). Each checkpoint has its own "What you will see" and "How to check" there.

- A: the default `worker` runs Chromium. A job completes right after parsing with both identity fields `pending`, and the reveal fills them in within `REVEAL_SECONDS = 120`, after which a pending field reads `unavailable`.
- B: the website keeps polling while a field is pending, shows the values on the listing card, and adds them to the report facts.
- C: opt-in profile reuse per worker, with count, age, block and failure resets. Fresh profiles remain the default after the [live comparison](checkpoints/2026-10-22-s3-c-warm-profile.md).

A and B run in parallel on separate branches; the plan's "Parallel work" section says which files each owns. The x86_64 server runs from S2 stay open alongside.

## S4: Transpordiamet background check

Designed in the [background check spec](specs/2026-10-22-transpordiamet-background-check-design.md), which also holds S4 A's "What you will see" and "How to check".

- A: `POST /v1/jobs/{job_id}/background-check` starts a lookup on a Chromium worker with the warm profile. It searches Transpordiamet's public background check by reg number, or by VIN when the reg number is missing, presses "Salvestan" and keeps the PDF with the job. The `GET` route returns the state, and `/pdf` returns the file.
- B: main roadmap [checkpoint 11](roadmap.md#checkpoint-11-background-check-starts-with-the-review). The report button starts the lookup, and the progress screen shows it.
- C: main roadmap [checkpoint 12](roadmap.md#checkpoint-12-background-check-in-the-findings). The final assessment waits for the PDF and uses it.

S4 follows S3 C, which merged in #55. The spec listed two tasks for you before S4 A: a recon session from a private window, and the Auto24 links for the live checks. The recon session is done. Task 6's live checks from the server still need your links and approval.
