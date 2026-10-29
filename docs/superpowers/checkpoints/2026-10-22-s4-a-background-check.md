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

- The driver, challenge handling and PDF receipt now support the S5 engine choice; see decisions 7–10 in the [background check spec](../specs/2026-10-22-transpordiamet-background-check-design.md#decisions).
- `pdf_check.py` accepts a download only if it starts with `%PDF-`, is at most 12 MB and one of its text strings equals the searched value, ignoring spaces and case. Part of a label or of another number never matches. It decodes iText's `Identity-H` text with the standard library. On the user's real recon PDF it matched the registration number and the VIN and rejected another plate.
- Debug screenshots black out the result header and both search fields.
- `open_chromium_session` shares the listing opener's launch, extension readiness, WebSocket guard and cleanup, with a site allowlist of the caller's choice. It kills Chromium 5 s after the session's deadline, so a download that stalls after its headers cannot hold the worker.
- Cloudflare's page is recognised by its title, as on the saved recon page, It gets one fixed 30 s limit on the search page and another after "Otsin", the result URL included.

## Offline evidence on Mac ARM64

| Check | Result |
| --- | --- |
| Complete sandbox Python suite, `--network none`, Tasks 1 to 4 after the review fixes | 757 passed, 3 skipped |
| MNT driver tests against fake pages, `chromium-test` | 19 passed |
| Offline network sandbox, `--engine chromium`, with one fake MNT lookup using the real extension | PASS, contacted hosts: none (`sandbox-reports/offline-20261022T170309Z`) |
| Complete sandbox Python suite after Task 5 | 766 passed, 4 skipped |
| Chromium subset after Task 5 | 113 passed |
| Complete sandbox Python suite after both Task 5 reviews | 777 passed, 4 skipped |
| Chromium subset after both Task 5 reviews | 117 passed |

## First live check, 2026-10-23

The user ran listing 4360808 through the website on a Mac, with the service built from main. The lookup ended as `unavailable`, `site_changed` after 32 s. A debug screenshot showed the site's error box "reCAPTCHA valideerimise viga" under an untouched search form.

- The search page loaded its form within about 1 s, before reCAPTCHA's `api.js`. The driver pressed "Otsin" at once. The button's own post went out with an empty token, and `getCaptchaToken()` threw because `grecaptcha` did not exist yet, so no second post followed.
- The fake search page posted only after the token, which is why the offline tests missed this. It now posts like the real page, and its v3 script loads 300 ms after the page by default.
- The driver now waits up to 15 s for `grecaptcha.execute` before it presses "Otsin", reading it in the page's own context. A `grecaptcha` that never loads ends as `captcha_failed`. When the answer limit runs out with the reCAPTCHA error showing, the search ends as `captcha_failed` instead of `site_changed`. Both get the one retry in a fresh session.
- With the fix, two live lookups by registration number from the Mac each fetched the PDF in about 5 s, and the value check passed. No visible challenge appeared, and the v3 token was accepted both times.

## Known gaps

- Camoufox jobs carry a registration too, so a `POST` on a Camoufox job answers `202` instead of the contract's `409`. No worker claims it, and it reads `unavailable`, `timeout` after 240 s. The user chose on 2026-10-22 to leave Camoufox for later and finish Chromium first.
- From a data-centre IP, Cloudflare showed its challenge page on the first load during recon. Whether Turnstile clears it from the server without a click is only known after the Task 6 live check; offline tests cover a fake Turnstile that clears and a page that never does.
- If a reCAPTCHA v2 checkbox ever passes without an image challenge, no challenge frame shows and the driver does not press "Otsin" again, so a found car would end as `site_changed`. Recon saw no v2 on the site. The Task 6 live check shows whether MNT sends the search by itself after the token.
