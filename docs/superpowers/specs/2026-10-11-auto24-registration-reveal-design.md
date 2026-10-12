# Auto24 registration number and VIN reveal

Status: design agreed in conversation on October 11, 2026. Awaiting user review of this written spec. No checkpoint is approved yet.

## Outcome

Auto24 shows only the start of the registration number and VIN (`562...`, `WDD222...`). The full values appear after a buyer clicks "näita reg. nr." or "näita VIN" and passes a reCAPTCHA Enterprise checkbox. One solve reveals both values.

The extraction service will click those links, solve the reCAPTCHA when it appears, and return the full registration number and VIN with the listing. The report shows both values with their source. The registration number is stored with the report so a later feature can request the taustakontroll PDF automatically.

## Decisions

These were settled in conversation and are not open for the implementation plan to change:

- The service solves reCAPTCHA automatically. This replaces the rule in the [Auto24 service design](../archive/auto24-service/2026-09-26-auto24-extraction-service-design.md) that the service does not interact with hidden controls or solve CAPTCHAs.
- Solving runs in Python inside the extraction worker (approach B). No browser extension is built and no upstream JavaScript runs.
- From [CaptchaRaptor/captchaplugin](https://github.com/CaptchaRaptor/captchaplugin) at commit `7462474d5fdfda5618becc9ac7a421de3ea69495` (MIT), the project takes only data files: `extension/models/type.onnx`, `extension/models/grid.onnx`, `extension/models/grid.meta.json` and `extension/db/captcha.sqlite`. The per-label thresholds in `extension/captcha/recaptcha_ai.js` are copied into our code as constants with attribution.
- The upstream 20% random answer flips on 4×4 grids are not ported. The rule that a static 3×3 answer selects 3 or 4 tiles is kept.
- Production captures use a fresh browser profile each time. The benchmark compares fresh and saved profiles; switching production to a saved profile is a later decision based on those results.
- The job lease stays at 2 minutes. The worker derives one deadline from the lease (lease end minus 15 s, about 105 s from claim) that covers navigation and both reveal attempts. A failed reveal is retried once in a new browser session. Attempt 1 gets the time left, up to 90 s. Attempt 2 runs only if at least 30 s remain; otherwise it is recorded as a timeout. The retry therefore covers fast failures, and slow failures are not retried. If the reveal still fails, the listing completes and the values are marked unavailable with the reasons.
- Camoufox runs without its bundled uBlock Origin, with DNS prefetch and speculative connections off and WebRTC blocked, so traffic stays inside the allowlist.
- When both reveal attempts fail, the analysis worker tries to read the registration number from up to 5 listing photos with the existing reviewer model. Photos cannot give a VIN.
- Revealed VINs are stored in the report only. No VIN lookup service receives them. Connecting any VIN lookup is a separate decision.
- The report keeps the "Ask the seller for the VIN" action whenever the VIN is missing, even when the registration number is known.
- Challenge images are saved only during benchmark runs.
- Accuracy gate: at least 8 of 10 reveals succeed within 3 CAPTCHA rounds, for each profile mode in the benchmark. If the gate fails, work stops and approach A (a Firefox port of the extension) is reconsidered.
- Claude does not run live captures, live sandbox runs, or the benchmark. The user runs them with commands Claude provides, and shares the output folders or reports.

## Solver files

The four upstream files live on a branch named `captcha-solver-assets` in this repository. The branch has no shared history with `main` and holds only these files, upstream's `LICENSE`, and a `SOURCE.md` naming the upstream repository, commit and file paths. Feature branches and worktrees never check the files out. The branch is permanent and is never deleted.

`main` holds `vendor/captcha-solver/SHA256SUMS` with the expected hash of each file. The test suite checks the hash file against the asset branch when the files are present.

`scripts/fetch-captcha-solver` fetches the asset branch through the user's existing git remote and extracts the files into a per-machine cache, `~/.cache/auto24/captcha-solver/<short hash of SHA256SUMS>/`. It verifies every file against `SHA256SUMS` and exits with an error, leaving no partial folder, on any mismatch. It never downloads from the upstream repository.

`compose.yaml` passes the cache folder to the image build as an additional build context. The Dockerfile copies the files to `/opt/captcha-solver/` and verifies the hashes again during the build. The worker opens `captcha.sqlite` read-only and immutable.

## Service components

All service code lives in `src/auto24_service/`.

**`captcha/solver.py`** has no browser dependency. Given the challenge label, the grid type and image bytes, it returns the tiles to click and a record of how it decided. It contains:

- Label mapping for the 16 labels the models know. The primary input is the label identifier from Google's challenge data (for example `/m/0k4j` for cars), which does not depend on language. The fallback is the instruction text, with upstream's English aliases and Estonian aliases. An unknown label is an explicit result, not a guess.
- The upstream perceptual hash: grayscale, resize to 32×32, 2D DCT, 63 low-frequency coefficients compared with their median. The resize filter is chosen during implementation and tuned with the benchmark's lookup hit rate.
- Lookup in `captcha.sqlite` (`phash33` for 3×3 tiles, `phash44` for whole 4×4 images) using the upstream band query and a Hamming distance below 10.
- ONNX inference with the `onnxruntime` Python package and upstream preprocessing: 100×100 input for tiles, `grid.meta.json` image size for 4×4, RGB scaled to the range 0 to 1, ImageNet mean and standard deviation, sigmoid outputs, per-label thresholds. When a 4×4 answer selects exactly one tile, the next most likely tile is added, as upstream does.
- Models load once per worker process and are reused across captures.

**`captcha/recaptcha.py`** drives the reCAPTCHA frames through Playwright. It finds the checkbox frame and clicks the checkbox. If a challenge frame opens, it reads the challenge from the network responses the browser already received: the `reload` response gives the challenge type, the label identifier and the grid size, the image responses give the exact challenge JPEGs, and the `userverify` response says whether verify passed. The DOM is used for clicking and as a fallback for the instruction text. It clicks tiles and the verify button with real mouse input, using Camoufox's human-like cursor movement and upstream's delays (300 ms between clicks and 850 ms before verify, each with up to 300 ms of random extra delay). It reads the round result: solved, another round, or "try again later". Tiles that refill after a click belong to the same round. A round ends when verify is pressed. It stops after 3 rounds.

**`captcha/reveal.py`** handles the Auto24 page. It finds the reveal links, clicks "näita reg. nr.", solves the CAPTCHA if one appears, reads the value, then clicks "näita VIN" and reads that value. It reads each value from the page and checks it against the value in Auto24's JSON response. It owns the retry and the 90-second limit per attempt. A test switch, `REVEAL_FORCE_FAILURE=true`, makes every attempt fail with `widget_not_found` so the fallback and diagnostics can be checked on demand. The worker refuses to start with the switch on unless a new setting, `AUTO24_ENV`, is `development` or `test`. `AUTO24_ENV` defaults to `production`.

**`browser.py`** keeps its current redirect rules and main-frame rules. The subresource guard additionally allows `https://www.google.com/recaptcha/` and `https://www.gstatic.com/recaptcha/` path prefixes, with no other Google paths and no other hosts. Auto24 loads reCAPTCHA with `hl=et`, so the browser language does not change the widget language. The service does not rewrite any Google request; the solver reads the language-independent label identifier instead (see `captcha/solver.py`). Camoufox keeps its default locale. Every blocked request is recorded in the solve record as host and path prefix only. Widening the allowlist further needs user approval.

**Worker and contracts.** The worker calls the reveal after capture and before saving the result. Results are stored in the existing job record, which gains additive fields only.

## Capture flow

1. Open the listing exactly as today. The request guard allows the reCAPTCHA paths for the whole session; on the sampled listing, the reCAPTCHA script only loads after the reveal click.
2. Save the page HTML before any click. Parsing uses this copy. The existing challenge check would otherwise match the widget's "reCAPTCHA" text.
3. Read the visible prefixes of the registration number and VIN. If neither row has a reveal link, skip the reveal. A row shown in full is recorded as `listed_in_full`. A missing row is recorded as `not_listed`.
4. Click "näita reg. nr." and wait for either the full value or the reCAPTCHA checkbox frame.
5. If the checkbox frame appears, solve it. A checkbox that passes without a challenge ends the solve. Otherwise solve up to 3 rounds. "Try again later" ends the attempt at once.
6. Click "näita VIN". It should reveal without another CAPTCHA. If one appears, solve it within the same round limit.
7. Read and check both values (rules below).
8. On failure, close the browser, open a fresh session, load the listing again and repeat steps 4 to 7, but only if at least 30 s remain before the job deadline (lease end minus 15 s, shared by navigation and both attempts). Otherwise record attempt 2 as a timeout. Attempt 1 gets the time left, up to 90 s. The listing parsed from the first attempt is kept.
9. Save the listing, the registration fields and the solve record as one completed job. Reveal failure never fails the job.

If a listing has only one of the two reveal links, the flow handles that link alone.

## Auto24 reveal mechanics

From the saved sample of listing 4341713 (October 11, 2026):

- Before the reveal, the registration row is `tr.field-reg_nr` with `span.preview` (`123...`) and a `span.service-trigger` with `data-action="uv_regnr"` and a per-listing `data-key`. The VIN row is `.field-tehasetahis` with `span.preview` (`WVWZZZ...`) and a trigger with `data-action="uv_vin"`.
- Clicking the registration trigger calls `GET /services/data_json.php?q=uv_regnr&k=<data-key>`. The JSON response inserts a row `tr.sub-field.field-reg_nr-gc2` containing a form `data-action="uv_regnr_sec"`, a hidden `ikey`, and the script `https://www.google.com/recaptcha/api.js?onload=reCapLiveRender&render=explicit&hl=et`.
- The reCAPTCHA uses the `api2` endpoints on `www.google.com` and a script from `www.gstatic.com/recaptcha/releases/`. Both fall under the allowed path prefixes.
- After a solve, Auto24 posts the token and `ikey` with `q=uv_regnr_sec` and the JSON response carries the value, which replaces `.field-reg_nr .value`.
- Clicking the VIN trigger afterwards calls `q=uv_vin` and gets the value straight away, with no CAPTCHA, because the session already passed one. The value replaces `.field-tehasetahis .value .-response`. Auto24 then calls `/services/requests/vin_report.php` on its own host.
- The user's session had OneTrust consent cookies from `cdn.cookielaw.org`, which the guard blocks. Whether the reveal works without a consent cookie is unknown. The live sandbox run answers this, and a failure shows as `value_not_found`.
- The user saw one image round with the label "Car" and a 3×3 grid. Google's `reload` response named the label as `/m/0k4j`.

## Value checks

Registration number: letters (including õ, ä, ö, ü, š, ž), digits, spaces and hyphens; not empty; at most 20 characters. The 20 is a guard against reading a whole paragraph, not a plate rule. Custom plates are allowed.

VIN: letters and digits only, at most 17 characters. `vin_format` is `standard` when the value is 17 characters without I, O or Q, and `nonstandard` otherwise. Cars built before 1981 often have shorter chassis numbers.

Prefix check: the revealed value must start with the prefix Auto24 showed before the click, compared without spaces and case. If Auto24 showed no prefix, the check is skipped and the solve record says so.

## Data contract

`ListingResult` gains a `registration` object:

| Field | Values |
| --- | --- |
| `reg_number` | full value or null |
| `reg_number_status` | `listed_in_full`, `revealed`, `not_listed`, `unavailable` |
| `vin` | full value or null |
| `vin_status` | same four values |
| `vin_format` | `standard`, `nonstandard`, or null |

`JobResponse` gains `reveal_diagnostics`, the solve record. The app's listing and job schemas ignore unknown fields, so the service change is safe to deploy before the app changes.

## Solve record

The record has one entry per attempt:

- Attempt number (1 or 2), start time, duration, outcome (`revealed`, `no_captcha_needed`, `failed`), and failure reason.
- Failure reasons come from a fixed list: `captcha_rounds_exhausted`, `try_again_later`, `timeout`, `widget_not_found`, `value_not_found`, `value_rejected`, `prefix_mismatch`, `label_unsupported`, `browser_error`, `listing_changed`.
- Whether the checkbox passed without a challenge.
- Per round: grid type (`3x3`, `3x3_dynamic`, `4x4`), instruction text, parsed label, method per tile or image (`lookup` or `model`), lookup hits, model scores, tiles clicked, duration, and Google's result.
- Prefix check result: `passed`, `failed` or `skipped`.
- Blocked requests as host and path prefix.

The record never contains the revealed values, cookies, tokens, response bodies, or images. Worker logs follow the same rule.

## App changes

These come after the redesign and change only the application, not the service.

- [`captured-job.ts`](../../../src/listings/captured-job.ts) maps the `registration` object to the existing `vin` and `registration plate` facts. Revealed and fully listed values keep the confidence of other Auto24 facts. Values read from a photo get lower confidence and the label "read from photo".
- [`normalize.ts`](../../../src/analysis/normalize.ts) keeps custom plates and nonstandard VINs. Standard formats are formatted as today. Other values are kept as Auto24 showed them, compacted and uppercased, with a format flag.
- The report shows the registration number and VIN in the vehicle details with their source: Auto24, read from photo, or unavailable with a short reason.
- The "Ask the seller for the VIN" action appears whenever the VIN is missing.
- The photo fallback runs in the analysis worker after photo preparation, only when `reg_number_status` is `unavailable` and the listing has photos. It sends up to 5 listing photos, already sent to the same provider for photo review, in one separate call that asks only for a visible registration plate. Two different plates, or a value failing the registration number check, leave the value unavailable with a recorded reason. The existing photo review is unchanged.
- The solve record appears in the Live diagnostics drawer on the listing page, next to Auto24 capture timings.

## Testing

Claude writes and runs these. None of them reach the internet.

- Solver: label parsing, hashing, lookup queries, and model inference on generated images, with no browser.
- Solver files: hash checks against `SHA256SUMS`.
- Driver and reveal flow: Camoufox against local fake pages served through Playwright routes. The fakes copy the real structure of an Auto24 listing with reveal links and of the reCAPTCHA checkbox and challenge frames. Cases: no CAPTCHA, checkbox only, 3×3, refilling 3×3, 4×4, wrong answers until 3 rounds run out, "try again later", timeout, a retry that succeeds, two failed attempts, a prefix mismatch, an unsupported label, and a blocked request.
- Request guard: allowed and rejected reCAPTCHA hosts and paths, and no rewriting of Google requests.
- Normalization: custom plates, nonstandard VINs, and the VIN action rule.

Fake pages cannot detect changes to Google's real page structure. The live benchmark covers that.

## Network sandbox

The user runs the sandbox with commands Claude provides.

A sandbox Compose file runs the capture container inside the network namespace of a logging container. The logging container records every DNS query and every outgoing connection with destination IP, port and TLS server name. This includes requests Firefox makes outside Playwright.

- Offline run: the fake-page tests run in the sandbox on a Docker network with no internet access. Expected outgoing traffic is none. Anything recorded is a finding, fixed for example by a Camoufox or Firefox preference.
- Live run: one real capture with a reveal. The contacted hosts must be a subset of `www.auto24.ee`, `www.google.com` and `www.gstatic.com`. The command prints PASS or FAIL and the full host list.

## Benchmark

`python -m auto24_service.captcha_benchmark --mode fresh|saved|both --listings <file> --label <name> [--reveals 10]` runs reveals one after another and writes `benchmarks/<label>-<UTC time>/` (ignored by git) containing `report.json`, `report.md` and the challenge images.

- Results per mode: reveals attempted and succeeded, rounds per success, checkbox-only passes, lookup hit rate, "try again later" count, failure reasons, and timings.
- The command prints PASS or FAIL against the accuracy gate for each mode.
- The report records the label, service version, Camoufox version, solver file hashes and time. It records no IP address.
- Saved mode keeps its profile in a temporary folder and deletes it at the end unless `--keep-profile` is given.
- It runs in the service image, so the same command works on any server.

## Checkpoints

### Service roadmap

A new file, `docs/superpowers/service-roadmap.md`, uses the main roadmap's format. Service work can proceed alongside the redesign.

**S1. Registration number and VIN in the extraction result**

Before starting:

- Rewrite the CAPTCHA and hidden-control sentences in the [Auto24 service design](../archive/auto24-service/2026-09-26-auto24-extraction-service-design.md) to point to this spec.
- Create the `captcha-solver-assets` branch from the pinned upstream commit, with user approval before pushing it.
- Done: the user saved listing 4341713 from a private Firefox window (page markup before and after the reveal, a HAR log, notes) in a folder outside the repository. Test pages built from it replace real values, keys, tokens and cookies with made-up ones. Findings are in "Auto24 reveal mechanics" below.

What you will see: in the extraction API docs page (`http://localhost:8000/docs`), a submitted listing returns the full registration number and VIN with their status, and the job includes the solve record.

How to check:

1. Run `scripts/fetch-captcha-solver` and confirm it reports all four files verified.
2. Run the offline sandbox and confirm it reports no outgoing traffic.
3. Run the live sandbox and confirm PASS with only the three allowed hosts.
4. Run the benchmark with `--mode both` on a few listings and confirm PASS for both modes.
5. Rebuild the Auto24 stack, submit a listing with hidden values in the API docs page, and compare the returned values with the listing in your own browser.
6. Submit a listing with no registration row and confirm `not_listed` and a completed job.

If step 4 fails the gate, stop and review approach A before continuing.

### Main roadmap

These are added to [roadmap.md](../roadmap.md) after the redesign. A2 also comes after roadmap checkpoint 2, Auto24 capture timings, because it uses that drawer.

**A1. Values in the report**

What you will see: a report shows the full registration number and VIN with "Auto24" as the source. A listing with a custom plate or an old VIN keeps it. A listing without a VIN shows the "Ask the seller for the VIN" action.

How to check:

1. Start the app, the worker and the Auto24 stack.
2. Submit a listing with hidden values and open its report.
3. Compare both values with the listing in your browser.
4. Open a report for a listing without a VIN and find the action.

**A2. Solve record in Live diagnostics**

What you will see: the Live diagnostics drawer on the listing page shows each reveal attempt, its rounds, labels, picks and failure reasons.

How to check:

1. Start everything with diagnostics enabled.
2. Submit a listing and open the drawer on the listing page.
3. Read the attempts and rounds.
4. Force a reveal failure with the test switch and confirm the drawer shows both attempts and their reasons.

**A3. Registration number from a photo**

What you will see: when the reveal fails, the report shows the registration number with the source "read from photo", or "unavailable" with a reason.

How to check:

1. Start everything with the reveal failure test switch on.
2. Submit a listing whose photos show a readable plate and confirm "read from photo".
3. Submit a listing whose photos show no plate and confirm "unavailable" with a reason.

## Out of scope

VIN lookups of any kind, automatic taustakontroll PDF requests, CAPTCHA types other than reCAPTCHA image grids, audio challenges, parallel captures, proxies, and any change to the existing photo review.
