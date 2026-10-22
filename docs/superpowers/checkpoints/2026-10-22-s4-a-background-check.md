# S4 A: Background check in the extraction service

Status: Tasks 1 to 4 are done and verified offline. Task 5 waits for the user's recon session. Tasks 5 and 6 are not started.

Authority: [background check plan, S4 A](../plans/2026-10-22-transpordiamet-background-check.md#s4-a-background-check-in-the-extraction-service), [development agent policy](../../agent-policy.md).

## What you will see

The spec's [S4 A section](../specs/2026-10-22-transpordiamet-background-check-design.md#what-you-will-see) describes the finished checkpoint. Until Task 5 lands, every lookup a Chromium worker claims ends as `unavailable` with reason `site_changed`, because the page driver does not exist yet. Camoufox workers never claim lookups.

## What Tasks 1 to 4 add

- The store keeps one `background_checks` row per job. Existing databases gain the table on start.
- The public API has the three routes of the shared contract. The `pdf` route serves a file only when the status is `fetched` and the file sits inside `BACKGROUND_CHECK_DIR`.
- The request guard has an `MNT` allowlist for `eteenindus.mnt.ee` and the reCAPTCHA paths.
- Chromium workers claim a pending lookup before a queued capture. A lookup's lease runs to `requested_at` plus 240 s, so one claim covers both in-browser attempts. A worker that dies mid-lookup leaves the row to read `unavailable`, `timeout`.
- Compose shares a `background_checks` volume: the worker writes it and the API reads it.

## Offline evidence on Mac ARM64

| Check | Result |
| --- | --- |
| Complete sandbox Python suite, `--network none` | 754 passed, 3 skipped, before the review fixes |
| Complete sandbox Python suite after the review fixes | 757 passed, 3 skipped |
| Independent final review | No Critical findings. Three findings fixed test-first |

No Chromium test changed in Tasks 1 to 4, so the `chromium-test` image was not needed.

## Known gap

Camoufox jobs carry a registration too, so a `POST` on a Camoufox job answers `202` instead of the contract's `409`. No worker claims it, and it reads `unavailable`, `timeout` after 240 s. The user chose on 2026-10-22 to leave Camoufox for later and finish Chromium first.
