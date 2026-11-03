# Transpordiamet background check PDF in the report

Status: approved by the user on 2026-10-22. Implementation plan: [Transpordiamet background check plan](../plans/2026-10-22-transpordiamet-background-check.md). It follows service checkpoint S3 C, which finished the move to Chromium and merged in #55. Roadmap rows: service checkpoint [S4](../service-roadmap.md#s4-transpordiamet-background-check) and main checkpoints [11](../completed-work.md#checkpoint-11-background-check-starts-with-the-review) and [12](../completed-work.md#checkpoint-12-background-check-in-the-findings).

## Outcome

The report button follows the identity gate described in [checkpoint 10's plan](../plans/2026-10-21-chromium-identity-integration.md#checkpoint-b-reg-number-and-vin-on-the-listing-page). Pressing it starts the review and, at the same time, the background check. The extraction service opens Transpordiamet's public vehicle background check in its lookup worker, searches by registration number, presses "Salvestan" on the result page, and keeps the taustakontroll PDF. The review adds the PDF as evidence before its final assessment. The buyer no longer has to download and upload it by hand.

The [Chromium engine spec](2026-10-19-chromium-extension-engine-design.md) already planned for the MNT vehicle service (`eteenindus.mnt.ee`) to run in the same browser, in a separate spec. This is that spec.

## The flow the service copies

The user described it on 2026-10-22:

1. Open `https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf`.
2. Type the registration number from the Auto24 listing into "Registreerimismärk".
3. Press "Otsin". Sometimes a CAPTCHA appears. After it is solved, press "Otsin" again.
4. `soidukDetailvaadeAvalik.jsf` opens. It shows the registration number, make and model and VIN at the top, then "Sõiduki põhiandmed", inspection and insurance status, manufacturer recalls, insurance data and more.
5. Press "Salvestan". The browser downloads the taustakontroll PDF.

## What the search page does

Read from the page source on 2026-10-22, without submitting the form:

- The page runs PrimeFaces 6.1 on JSF. Every request carries `javax.faces.ViewState`, so the service has to drive the real page. Posting the form directly would not work.
- The search form is `soidukOtsingForm`, with the text fields `soidukOtsingForm:regMark` and `soidukOtsingForm:vinKood` (17 characters at most) and a hidden `soidukOtsingForm:recaptchaResponse`.
- "Otsin" posts the form twice. Its own PrimeFaces AJAX call posts at once with whatever `recaptchaResponse` holds, which is empty on the first press, and the site answers "reCAPTCHA valideerimise viga". `getCaptchaToken()` also calls `grecaptcha.execute` with reCAPTCHA v3, invisible, action `soiduk_otsing`, puts the token in `recaptchaResponse` and posts again through `otsiAction()`. That second answer replaces the error. If `grecaptcha` has not loaded yet, `getCaptchaToken()` throws and only the first post is sent, so the driver waits for `grecaptcha.execute` before it presses "Otsin". Found in the first live check on 2026-10-23. The button's own id (`j_idt160`) is generated and can change.
- The visible challenge that sometimes appears is probably the site's fallback when the v3 score is low. Its type is not known yet. It may be a reCAPTCHA v2 challenge, which the CaptchaRaptor extension already solves on Auto24, or something else. The recon session below settles this.
- The page loads Cloudflare's challenge script from `/cdn-cgi/challenge-platform/` on the same host, plus Google Tag Manager, Google Analytics and Cloudflare Insights.
- The page asks buyers to search by registration number and VIN together, because then the register checks that both belong to the same car. When they do not match, it answers "Sisestatud andmetega sõidukit registris ei ole!" and shows no vehicle.

The user's recon session on 2026-10-22 added these findings. The saved pages and HAR logs stay outside the repository.

- From a home connection, 7 searches in two private windows showed no visible challenge. Each search opened the result after one press of "Otsin". The page code has no visible reCAPTCHA fallback: no `grecaptcha.render`, no `data-sitekey` and no v2 checkbox. reCAPTCHA appears only as the invisible v3 badge.
- From a VPN exit in a Finnish data centre, the first load of the search page returned `403` with Cloudflare's "Just a moment..." page. That page loads Turnstile from `challenges.cloudflare.com` and cleared by itself after about 9 s, without a click. Searches after that showed no challenge. A server IP will likely meet this page on most fresh sessions.
- The "not in the register" answer stays on the search page in `div.message-error`. The same sentence also appears in the page's help text, so the driver reads only the error box.
- A found car redirects to `soidukDetailvaadeAvalik.jsf`. Its header shows the registration number in `h1` and the VIN in the next line. The page has two "Salvestan" links. The first one, in the header area, posts the `soidukDetailid` form to the same URL, and the response is the PDF as an attachment (`Content-Type: application/pdf`, file name `DETAILANDMED_<reg number>.pdf`).
- The PDF is made by iText 2.1.7. Its text uses subset fonts with `Identity-H` encoding and `ToUnicode` maps, so the registration number is not in the raw bytes. The value check decodes the text through those maps with the standard library.
- Task 5 decision, made with the user on 2026-10-22: the driver handles a visible reCAPTCHA v2 frame with the extension, as decision 7 says. Any other visible challenge ends as `unavailable`, `captcha_failed`. A Cloudflare page that does not clear within 30 s ends as `unavailable`, `blocked`. On 2026-10-22 the user approved adding `challenges.cloudflare.com` to the `MNT` allowlist, so a Cloudflare page that needs Turnstile can clear in the worker.

## Decisions

The user approved these on 2026-10-22, apart from the details in decisions 5 to 13 that follow from them. The service solves the site's CAPTCHA, as on Auto24. It does not ask Transpordiamet for authorized access.

1. The lookup runs in the extraction service. Chromium uses the CaptchaRaptor extension; S5 adds invisible_playwright in its own non-root Docker image, never on the host. Neither uses an outside CAPTCHA service.
2. See [local development](../../local-development.md#invisible-lookup-worker) for lookup worker selection, defaults and startup commands. Chromium uses the warm profile from S3 C when enabled; invisible uses fresh sessions. Each worker runs one browser task at a time.
3. The service searches by registration number only, as the user does. When the registration number is `not_listed` or `unavailable` and the VIN is known, it searches by VIN only. It never fills in both. A mismatch would return "not in the register" and no PDF. The report compares the VIN on the PDF with the listing's VIN instead, and a mismatch becomes a finding. That catches the case the site warns about, where a listing shows another car's VIN.
4. The lookup starts when the buyer presses the report button on the listing page, and the review uses the PDF automatically. Nothing runs for listings that never become a report.
5. The website starts the lookup when it creates the report from an Auto24 job. The service reads the registration number and VIN from its own job, so the website never sends them. Reports from manual entry have no job and get no lookup.
6. The photo and text steps of the review run while the lookup runs. The final assessment waits until the lookup has a final status or its deadline passes. While it waits, the final step goes back in the queue with a later `availableAt`, so no worker sits idle. The final assessment runs once, with the PDF when there is one.
7. The v3 token needs no clicks. Chromium waits for reCAPTCHA readiness in the page's own world; invisible checks for the badge in the DOM. Chromium lets the extension solve a visible challenge and presses "Otsin" again. On invisible a visible challenge ends the attempt as `captcha_failed`, without loading the extension solver. Both engines use the limits in `src/auto24_service/mnt_lookup.py`'s `Limits`. A completed token-bearing response that rejects reCAPTCHA ends the attempt immediately. A scriptless plain form post or MNT's "Palume proovida hiljem uuesti" outage page ends it as `blocked`, including outages on result pages. These failures and `captcha_failed` retry once in a fresh session when at least 10 seconds remain before the lookup deadline.
8. After pressing "Salvestan", Chromium receives the PDF through Playwright's download event; invisible receives a PDF or attachment response because it has no download events. The service accepts the file only if it starts with `%PDF-`, is at most 12 MB (the upload form's `MAX_PDF_SIZE`), and one of its text strings equals the registration number or VIN it searched for, ignoring spaces and case. The recon PDF writes each value as a text string of its own, and a whole-string match keeps a short value from matching part of a label or of another number. Anything else ends as `unavailable` with reason `pdf_rejected`. The website runs its usual PDF checks in `src/server/storage/pdf-text.ts` before the review uses the file.
9. The request guard gets an MNT entry. The main frame and subresources may come from `eteenindus.mnt.ee`, including `/cdn-cgi/challenge-platform/`, plus the reCAPTCHA paths on `www.google.com` and `www.gstatic.com`. Frames and subresources may also come from `challenges.cloudflare.com`, which serves Turnstile for Cloudflare's "Just a moment..." page; it is never allowed as the main frame. The guard blocks Tag Manager, Analytics and Cloudflare Insights and lists them in `blocked_requests`. The offline sandbox checks the list.
10. Selectors use stable ids such as `soidukOtsingForm:regMark` and the visible button texts "Otsin" and "Salvestan", never generated `j_idt` ids. A missing element ends as `unavailable` with reason `site_changed`.
11. The service keeps the PDF with its job, on the service's data volume, for as long as it keeps the job. The job record stores its size and SHA-256.
12. The website copies the PDF into its own upload storage and keeps it in `analysis_background_checks`, its own table per report, never as a submission. Checkpoint 12 adds it to the final review input with a new source-record `providedBy: "transpordiamet"`. If a run's input is already locked without the PDF, a dedicated reuse run with both `parent_run_id` and `review_reuse_run_id` adds it and queues only `enrich` and `assemble_report`. The buyer sees this as a new run and may see progress reopen. The user approved this behavior on 2026-10-24. A valid accepted PDF, whether uploaded manually or fetched by the service, interrupts active model requests for a superseded run. The replacement run keeps completed text and photo results and retries unfinished passes before its final assessment with the PDF. Rejected uploads leave the current review running. Before input is locked, the first eligible enrich includes the PDF without creating a child. The reviewer input labels it as fetched by the service from Transpordiamet. Like any PDF, its text is evidence and never instructions. Later runs of the same report, such as after a seller reply or a retry, load it independently of submissions and retain manually uploaded PDFs too.
13. Each listing job gets at most one lookup. Starting it again returns the existing one. The buyer can still upload a PDF by hand, and the report keeps both. The manual link in `src/research/official-links.ts` stays.

## Contract

Three routes on the public API, each with the API key like the other routes:

- `POST /v1/jobs/{job_id}/background-check` starts the lookup and returns its state with `202`. A second call returns the same lookup. It answers `409` while the job is not `completed` or an identity field is still `pending`.
- `GET /v1/jobs/{job_id}/background-check` returns the state.
- `GET /v1/jobs/{job_id}/background-check/pdf` returns the PDF when the status is `fetched`, and `404` otherwise.

The state:

```json
{
  "status": "pending",
  "requested_at": "2026-10-22T12:01:00Z",
  "searched_by": null,
  "reason": null,
  "fetched_at": null,
  "size_bytes": null,
  "sha256": null
}
```

- `status` is one of `not_requested`, `pending`, `fetched`, `not_found`, `skipped` or `unavailable`.
- `searched_by` is `reg_number`, `vin` or `null`.
- `fetched` means the PDF is ready. `size_bytes`, `sha256` and `fetched_at` are set exactly then.
- `not_found` means the site said the car is not in the register.
- `skipped` means there was nothing to search with. Its reason is `no_identity`.
- `unavailable` has one of these reasons: `captcha_failed`, `blocked` (a Cloudflare page or "try again later"), `timeout`, `pdf_rejected`, `site_changed` or `browser_crash`.
- Pending lookup deadlines and worker availability follow [lookup availability and deadlines](#lookup-availability-and-deadlines).
- Jobs from before S4 and Camoufox jobs answer `not_requested` and refuse the `POST` with `409`. The report then runs as before.
- Tests use fake values only, such as `123ABC` and `WVWZZZ1KZAW000001`.

### Lookup availability and deadlines

Lookup workers send an authenticated `POST /internal/background-checks/heartbeat` every 5 seconds, independently of browser work. Chromium sends it only when `CHROMIUM_LOOKUPS=true`. Storage keeps the latest heartbeat in memory because it runs in one uvicorn process. A storage restart starts a new grace period.

On a state read, storage marks an unclaimed pending lookup `unavailable`, `browser_crash` when at least 20 seconds have passed since both its request and storage startup, and no heartbeat arrived in the last 20 seconds. That result is persisted and cannot be retried. A worker that returns before the next state read may still claim the lookup, even after an outage longer than 20 seconds. The existing `browser_crash` reason avoids a new reason requiring a Supabase CHECK constraint migration.

A worker that keeps sending heartbeats preserves the full `BACKGROUND_CHECK_SECONDS = 240` deadline from `requested_at`, even while busy. A claimed lookup also keeps that deadline if its worker dies. At the deadline, the service reports `unavailable`, `timeout`, and the website reads an older pending check the same way. The deferred website stage persists that timeout so the report leaves "Checking" and finishes without a PDF.

Regression coverage is in `tests/test_lookup_availability.py`, `tests/test_lookup_heartbeat.py` and `tests/unit/analysis/background-check-stage.test.ts`.

## Failures

| What happens | Result |
| --- | --- |
| No registration number and no VIN | `skipped`, `no_identity`; the final assessment does not wait |
| The site says the car is not in the register | `not_found` |
| The visible challenge fails 3 rounds, or stalls for 20 s, twice | `unavailable`, `captcha_failed` |
| `grecaptcha` does not load within 15 s, or no answer comes and the reCAPTCHA error shows, twice | `unavailable`, `captcha_failed` |
| A Cloudflare challenge page or "try again later" | `unavailable`, `blocked` |
| The search form, the result page or "Salvestan" is missing | `unavailable`, `site_changed` |
| No download, or a file that fails the checks in decision 8 | `unavailable`, `pdf_rejected` |
| Chromium crashes | `unavailable`, `browser_crash` |
| No worker heartbeat or nothing final before the deadline | See [lookup availability and deadlines](#lookup-availability-and-deadlines) |
| The website cannot reach the service to start the lookup | the report runs without the PDF and says the background check was not started |

A failed lookup never fails the report. The report says why the PDF is missing, and the buyer can upload it by hand, as today.

## Privacy

- The PDF holds the registration number, the VIN and the car's history. The rules for revealed values apply to it: no PDF text, registration number or VIN in logs, diagnostics, progress lines or benchmark reports.
- Debug screenshots of the result page mask the registration number and VIN, as the reveal does.
- Recon pages and test fixtures replace real values, keys, tokens and cookies with fake ones. No real PDF is committed.

## Risks

- Cloudflare may challenge or block the server's IP. Lookups then end as `blocked`, and buyers upload by hand as today.
- A server IP may get low reCAPTCHA v3 scores, so the visible challenge may appear on most lookups. The S4 A benchmark measures how often.
- A site update can change the page. Decision 10 keeps that to a `site_changed` result instead of a wrong PDF.
- When every worker is busy with captures, the lookup and final assessment wait according to [lookup availability and deadlines](#lookup-availability-and-deadlines).

## Testing

- Offline tests run against saved recon pages with fake values: the search page, the page with the visible challenge, the "not in the register" answer, the result page and the download. They run in the sandbox image with `--network none`.
- Guard tests try each blocked host and check that it is stopped and listed.
- Contract tests cover every status and reason, the `409` cases, a second `POST`, the 240 s deadline on both sides, and old jobs.
- Website tests cover starting the lookup with the report, the final step waiting and then running once, the fetched PDF source with `providedBy: "transpordiamet"` outside submissions and its dedicated reuse run when input is already locked, the reuse on later runs, every missing-PDF reason, and the VIN mismatch finding.
- Agents run offline tests only. Live lookups and the benchmark need the user's approval each time.
- The benchmark runs lookups on listings the user supplies and reports how often the visible challenge appeared and how many lookups ended `fetched` or `not_found` on the first attempt. The proposed gate is 9 of 10.

## Your tasks before S4 A

These need the user and are not part of a checkpoint.

1. Save a recon session from a private window, as for S1: the search page, a search that shows the visible challenge and one that does not, a "not in the register" answer, the result page, and the "Salvestan" request and its response, with a HAR log and notes. Keep it in a folder outside the repository. Agents build the fake-value test pages from it.
2. Supply the Auto24 links for the live checks and the benchmark.

## S4 A: Background check in the extraction service

### Before starting

- Record the CAPTCHA type and the "Salvestan" request from the recon session in this spec.
- The [implementation plan](../plans/2026-10-22-transpordiamet-background-check.md) splits the work like S3: S4 A and roadmap checkpoint 11 build in parallel against its frozen contract, on separate branches that own separate files.

### What you will see

In the extraction API docs page (`http://localhost:8000/docs`), `POST /v1/jobs/{job_id}/background-check` on a completed job returns `pending`. A few polls of the `GET` route later it reads `fetched`. The `pdf` route returns a PDF that opens in a PDF viewer and shows the same car as the listing.

### How to check

1. Rebuild the Auto24 stack and start it as described in [local development](../../local-development.md).
2. In the API docs page, submit a listing you supply whose registration number is hidden behind "näita reg. nr.". Wait until the job is `completed` and the reg number is no longer `pending`.
3. Start the lookup with the `POST` route. Poll the `GET` route until the status is no longer `pending`.
4. Download the PDF from the `pdf` route. Open it and compare the registration number, VIN and make with the listing in your own browser.
5. Call the `POST` route again. It returns the same lookup and does not start a second one.
6. Submit a listing with no registration number but a VIN. The lookup reports `searched_by: "vin"`.
7. Read the worker log and the job's diagnostics. Neither shows the registration number, the VIN or PDF text.
8. Run the offline sandbox and check that it reports no outgoing traffic, then the guard tests.
9. Run the benchmark on the listings you supply and compare the result with the 9 of 10 gate.

Website checkpoint 11's checks are in the [completed work log](../completed-work.md#checkpoint-11-background-check-starts-with-the-review). Checkpoint 12 is in the [completed work log](../completed-work.md#checkpoint-12-background-check-in-the-findings).
