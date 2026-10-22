# S4 A: Background check in the extraction service

Status: Tasks 1 to 5 are done and verified offline. Task 6 (benchmark, docs and the live checks) is not started; its live runs need the user's approval.

Authority: [background check plan, S4 A](../plans/2026-10-22-transpordiamet-background-check.md#s4-a-background-check-in-the-extraction-service), [development agent policy](../../agent-policy.md).

## What you will see

The spec's [S4 A section](../specs/2026-10-22-transpordiamet-background-check-design.md#what-you-will-see) describes the finished checkpoint. Camoufox workers never claim lookups.

## What Tasks 1 to 4 add

- The store keeps one `background_checks` row per job. Existing databases gain the table on start.
- The public API has the three routes of the shared contract. The `pdf` route serves a file only when the status is `fetched` and the file sits inside `BACKGROUND_CHECK_DIR`.
- The request guard has an `MNT` allowlist for `eteenindus.mnt.ee` and the reCAPTCHA paths.
- Chromium workers claim a pending lookup before a queued capture. A lookup's lease runs to `requested_at` plus 240 s, so one claim covers both in-browser attempts. A worker that dies mid-lookup leaves the row to read `unavailable`, `timeout`.
- Compose shares a `background_checks` volume: the worker writes it and the API reads it.

## What Task 5 adds

- `mnt_lookup.py` drives the search page in a guarded Chromium session with the `MNT` allowlist. It fills the registration number field or the VIN field, never both, presses "Otsin", and on the result page presses the first "Salvestan" and takes the PDF from the download event.
- A Cloudflare "Just a moment..." page gets 30 s to clear, then ends as `blocked`. The `MNT` allowlist lets it load Turnstile from `challenges.cloudflare.com` in frames and subresources, as the user approved on 2026-10-22. A visible reCAPTCHA v2 challenge is left to the extension, with 3 rounds and a 20 s stall timer, and "Otsin" is pressed again after a pass. Any other visible challenge ends as `captcha_failed`. A failed challenge gets one retry in a fresh session.
- `pdf_check.py` accepts a download only if it starts with `%PDF-`, is at most 12 MB and one of its text strings equals the searched value, ignoring spaces and case. Part of a label or of another number never matches. It decodes iText's `Identity-H` text with the standard library. On the user's real recon PDF it matched the registration number and the VIN and rejected another plate.
- Debug screenshots black out the result header and both search fields.
- `open_chromium_session` shares the listing opener's launch, extension readiness, WebSocket guard and cleanup, with a site allowlist of the caller's choice. It kills Chromium 5 s after the session's deadline, so a download that stalls after its headers cannot hold the worker.
- Cloudflare's page is recognised by its title, as on the saved recon page, and has one fixed 30 s limit wherever it shows up, the result URL included.

## Offline evidence on Mac ARM64

| Check | Result |
| --- | --- |
| Complete sandbox Python suite, `--network none`, Tasks 1 to 4 after the review fixes | 757 passed, 3 skipped |
| MNT driver tests against fake pages, `chromium-test` | 19 passed |
| Offline network sandbox, `--engine chromium`, with one fake MNT lookup using the real extension | PASS, contacted hosts: none (`sandbox-reports/offline-20261022T170309Z`) |
| Complete sandbox Python suite after Task 5 | 766 passed, 4 skipped |
| Chromium subset after Task 5 | 113 passed |

## Known gaps

- Camoufox jobs carry a registration too, so a `POST` on a Camoufox job answers `202` instead of the contract's `409`. No worker claims it, and it reads `unavailable`, `timeout` after 240 s. The user chose on 2026-10-22 to leave Camoufox for later and finish Chromium first.
- From a data-centre IP, Cloudflare showed its challenge page on the first load during recon. Whether Turnstile clears it from the server without a click is only known after the Task 6 live check; offline tests cover a fake Turnstile that clears and a page that never does.
