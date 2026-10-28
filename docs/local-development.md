# Local development

## Run the whole project locally

Use Node 24 and a running Docker engine.

1. Install application dependencies with `pnpm install --frozen-lockfile`.
   Run `corepack enable` once if `pnpm` is not found. pnpm keeps one package
   store per computer, so each extra worktree adds links instead of a full copy.
2. Configure the Auto24 private environment file and start its Compose stack
   using [Auto24 extraction setup](#auto24-extraction-setup) below.
3. Start local Supabase with `pnpm supabase start`. On an existing database, apply
   pending migrations with `pnpm supabase migration up --local`. Preserve existing
   reports and uploads; do not reset the database. Every worktree shares this
   one stack through `project_id` in `supabase/config.toml`. A disposable stack
   started under another project ID keeps about ten containers and its own
   database until you remove it with
   `pnpm supabase stop --no-backup --project-id <id>`.
4. If `.env.local` does not already exist, copy `.env.example` to `.env.local`.
   Set `AUTO24_SERVICE_URL=http://127.0.0.1:8000` and make
   `AUTO24_SERVICE_API_KEY` match the extraction service's `PUBLIC_API_KEY`.
   Configure independent cookie secrets, the local Supabase URL and service role
   key, and a unique `WORKER_ID`. Keep secrets private and server-only.
5. Configure the reviewer as described in
   [Private analysis reports](#private-analysis-reports), or set
   `DATA_REVIEW_ENABLED=false` for an explicit baseline-only report.
6. In separate terminals, run `pnpm dev` and `pnpm worker`. For a shared
   database, use the worker's `--created-after` option below to leave older
   reports untouched.

| Interface | Default local URL |
| --- | --- |
| English frontend | http://localhost:3000/en |
| Estonian frontend | http://localhost:3000/et |
| Auto24 extraction API documentation | http://localhost:8000/docs |

Use the port printed by Next.js if port 3000 is occupied or a custom port is
configured. Port 8000 serves the extraction API; the car dashboard and reports
are served by Next.js.

## Auto24 extraction setup

Submit an Auto24 passenger-car listing URL, then poll for a stored result. The
worker uses Chromium to capture the public page; Camoufox is an opt-in
alternative. The storage service alone opens the embedded Turso database; the API
and worker reach it over the private Compose network. The database lives in the
`turso_data` named volume.

Run `scripts/fetch-captcha-solver`, `scripts/fetch-browser-assets` and
`scripts/fetch-browser-build-inputs` before any `docker compose ... build`. The
builds read these cache folders as additional contexts. The CaptchaRaptor solver
cache (`fetch-captcha-solver`) is needed for the `:compose` image used by
storage, api and `worker-camoufox`. The browser assets are needed for the
default Chromium `worker`, which builds `Dockerfile.chromium` with
`browser_assets: ${HOME}/.cache/auto24/browser-assets`.

Create a private environment file outside this checkout. Choose independent,
random public and internal keys, for example:

```sh
scripts/fetch-captcha-solver
scripts/fetch-browser-assets
scripts/fetch-browser-build-inputs
umask 077
ENV_DIR="$HOME/.config/auto24"
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
ENV_FILE="$ENV_DIR/auto24.env"
printf 'PUBLIC_API_KEY=%s\nINTERNAL_API_KEY=%s\nAPI_BIND=127.0.0.1:8000\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$ENV_FILE"
docker compose --env-file "$ENV_FILE" -p auto24 up --build -d
docker compose --env-file "$ENV_FILE" -p auto24 ps
```

Compose requires `PUBLIC_API_KEY` and `INTERNAL_API_KEY` from that private file.
`API_BIND` defaults to `127.0.0.1:8000`; only the public API publishes a host
port. `STORAGE_URL=http://storage:8001` is set on API and worker, and
`TURSO_DB_PATH=/data/auto24.db` is set only on storage. All three services have
health checks and restart policies. The storage Uvicorn command uses one process
without reload. The worker health check verifies process liveness; it does not
measure progress during an in-flight capture. The `:compose` image
(storage, api and `worker-camoufox`) still supports the manual one-link command:

```sh
scripts/fetch-captcha-solver
docker build \
  --build-context captcha_solver="$HOME/.cache/auto24/captcha-solver/current" \
  -t auto24-extraction-service:manual .
docker run --rm auto24-extraction-service:manual https://www.auto24.ee/soidukid/4344096
```

## Submit and poll

The example listing was public during development; use a current public
passenger-car URL for new work. Load the public key into the shell without
printing it, then submit and poll using the returned job ID:

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
set -a; . "$ENV_FILE"; set +a
curl -sS -i -X POST http://127.0.0.1:8000/v1/jobs \
  -H "X-API-Key: $PUBLIC_API_KEY" -H 'Content-Type: application/json' \
  --data '{"url":"https://www.auto24.ee/soidukid/4344096"}'
curl -sS -i http://127.0.0.1:8000/v1/jobs/JOB_ID \
  -H "X-API-Key: $PUBLIC_API_KEY"
```

Submission returns HTTP 202, `job_id`, `status: queued`, and `status_url`.
Polling returns `queued`, `running`, `completed`, or `failed`. A completed job
has a `listing` and UTC `parsed_at`; a failed job has a typed `error.code` such
as `listing_gone`, `access_blocked`, `unsupported_vehicle_type`, `parse_failed`,
or `temporary_failure`. A missing or wrong API key returns 401. An unsupported
URL returns 400. An unknown job ID returns 404. If storage is unavailable,
submission or polling returns 503. For example:

```sh
curl -sS -i -X POST http://127.0.0.1:8000/v1/jobs \
  -H "X-API-Key: $PUBLIC_API_KEY" -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/soidukid/1"}'
# HTTP/1.1 400 Bad Request; {"detail":"Invalid listing URL"}
```

## Registration reveal

The worker reveals the registration number and VIN by solving the listing's
reCAPTCHA. On Camoufox it solves it with the solver files; on Chromium the
extension solves it. The Camoufox solver files are not in Git history on `main`.

### Fetch the solver files

```sh
scripts/fetch-captcha-solver
```

It extracts the pinned files from the `captcha-solver-assets` branch, checks
them against `vendor/captcha-solver/SHA256SUMS` and caches them under
`~/.cache/auto24/captcha-solver/`. It prints `verified: <name>` for each of
`type.onnx`, `grid.onnx`, `grid.meta.json` and `captcha.sqlite`, then the cache
folder. Run it before building the image.

### Check network traffic

The network sandbox runs the capture container next to a logging container
that shares its network namespace. The logging container records every DNS
query and every outgoing connection with destination IP, port and TLS server
name, including requests Firefox makes on its own. Build the service image
first.

```sh
INTERNAL_API_KEY=test PUBLIC_API_KEY=test docker compose -p auto24 build
scripts/network-sandbox offline
scripts/network-sandbox live --url https://www.auto24.ee/soidukid/<listing id>
```

Offline mode runs the fake-page tests on a Docker network with no internet
access. It passes only when nothing leaves the container. Live mode makes one
real capture with a reveal and prints only statuses, never revealed values. It
passes when every contacted host is `www.auto24.ee`, `www.google.com` or
`www.gstatic.com`. Both print PASS or FAIL and the full host list.

Offline mode also looks up `sandbox-canary.invalid` once and fails if the log
misses it. Live mode fails if `www.auto24.ee` is missing from the log.

Captures run without Camoufox's bundled uBlock Origin and with Firefox DNS
prefetch and speculative connections off, because the first offline sandbox run
showed them contacting filter-list hosts and resolving hosts nobody requested.

Each run saves `traffic.txt` and `summary.txt` under
`sandbox-reports/<mode>-<UTC time>/`. That folder is ignored by Git.
Add `--debug` to live mode (`live --url <listing> --debug`) to save full-page screenshots of the listing and widget plus `events.jsonl` (frame hosts and paths, widget state, click points) under `debug/` in the report folder. The screenshots mask the reg number and VIN value cells but still show the page and the challenge, so the folder stays local.

### Benchmark

Put one listing URL per line in `benchmarks/urls.txt`, then run:

```sh
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 --profile camoufox run --rm \
  -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker-camoufox \
  -m auto24_service.captcha_benchmark --mode fresh saved \
  --listings /app/benchmarks/urls.txt --label <name> --revision "$(git rev-parse HEAD)"
```

`--engine camoufox|chromium|both` picks the engine (default `camoufox`).
`--mode` takes one or more of `fresh`, `saved` and `shared`. `both` is a
shorthand for `fresh saved`, and the default is `fresh saved`. Results are keyed
`<engine>/<mode>`, for example `chromium/fresh`. Only the `*/fresh` results
decide the exit code (at least 8 of 10 reveals on attempt 1), and a capture
error counts as a failed reveal. A run with no `*/fresh` result, such as
`--mode shared` alone, exits 1 and the summary says there is no gated result. `saved` and `shared` are reported, not gated.
The `chromium/saved` mode keeps one Chromium profile between captures and uses
the worker's reset rules. Its report includes `profile_resets`. The
`chromium/fresh` mode starts each capture with a new profile.

`shared` is Chromium only. It runs every listing in a new page of one browser
session. A reveal retry therefore reuses that session's browser context, where
`fresh` launches a new browser for the retry. Read `chromium/shared` as "does a
warm session help?", not as a like-for-like retry count. If the shared session
cannot open on a listing, that listing is recorded as a capture error and the
session opens on the next one. Only if none opens is every listing a capture
error. The other results still get their report. The summary shows how many reveals needed no
CAPTCHA (`no_captcha_needed`).

For the Chromium engine, run the same module in the default `worker` image (see
[Chromium engine](#chromium-engine)).

Reports land in `benchmarks/<name>-<UTC time>/`, which Git ignores.
Build from the committed revision passed to `--revision`. Reports include each
capture, including expired or skipped listings, field statuses without values,
capture wall time, grid counts, and whether a retry ran or was skipped. A listed
value or absent field does not prove a successful hidden-field reveal.
Each capture gets the worker's lease deadline (a 2-minute lease starting with that capture, minus 15 s), so attempt 1 and attempt 2 are cut the same way as in production.
While it runs, it prints one line per listing with the outcome, the time per attempt and the running count of first-attempt passes. The lines show listing numbers, never URLs or revealed values.
Add `--debug` to save page screenshots and `events.jsonl` per reveal under `debug/<mode>-<n>/` in the run folder (frame hosts and paths, widget state, the challenge data's structure, the tiles picked and shown selected, Google's verdict). The screenshots mask the reg number and VIN value cells and stay local.

### Forced failure

`REVEAL_FORCE_FAILURE=true` makes every reveal fail so you can check how the
app shows it. The worker refuses to start with it unless `AUTO24_ENV` is
`development` or `test`.

### Hash lookup

The perceptual-hash table in `captcha.sqlite` proved stale in the first live
benchmark, so the solver ignores it and the ONNX models decide every tile.
`CAPTCHA_LOOKUP_ENABLED=true` turns the lookup back on. The default is `false`,
and any other value stops the worker at startup. The benchmark report records
the setting.

## Chromium engine

A second capture engine runs ungoogled-chromium with Patchright and a local
CaptchaRaptor extension. `CAPTURE_ENGINE=chromium` selects it and is the
default in Compose; `camoufox` is the opt-in alternative. The extension solves the reCAPTCHA, and the reveal only watches it
(`solver: extension` in the solve record). The wait stops after 20 s without
progress, and the value appearing ends it. Diagnostics show `engine: chromium`
and `extension_loaded: true`. The design is in the
[Chromium engine spec](superpowers/specs/2026-10-19-chromium-extension-engine-design.md).

Fetch and verify the pinned inputs, then build the image:

```sh
scripts/fetch-browser-assets
scripts/fetch-browser-build-inputs
# x86_64 server:
docker buildx build -f Dockerfile.chromium --platform linux/amd64 \
  --build-context browser_assets="$HOME/.cache/auto24/browser-assets" \
  --load -t auto24-extraction-service:chromium .
# ARM machine:
docker buildx build -f Dockerfile.chromium --platform linux/arm64 \
  --build-context browser_assets="$HOME/.cache/auto24/browser-assets" \
  --load -t auto24-extraction-service:chromium .
```

`fetch-browser-assets` prints `verified:` for the Chromium archives for both
architectures, the CaptchaRaptor source and `onnxruntime-web`. The build runs its install steps
with no network.

The Chromium worker uses a fresh browser profile for each job by default. Set `CHROMIUM_WARM_PROFILE=true` to keep a profile between jobs. A kept profile resets after an `access_blocked` capture error or `try_again_later` reveal reason, a `browser_launch` or `extension_not_loaded` capture error, a reveal without any value whose attempts include `captcha_rounds_exhausted` or `timeout`, or two consecutive `temporary_failure` capture errors. Any other outcome clears the temporary failure streak. It also resets after 30 jobs or 10 hours from creation. Reset priority and log reasons are `blocked`, `launch`, `failed_reveal`, `temporary`, `count`, then `age`. Logs keep `profile_jobs=<n>` and `profile_reset reason=<reason>`. A worker restart starts a new profile. Set `CHROMIUM_WARM_PROFILE=false` to return to fresh profiles. The [S3 C benchmark evidence](superpowers/checkpoints/2026-10-22-s3-c-warm-profile.md) records the default decision.

The default `worker` runs Chromium:

```sh
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 \
  up -d storage api worker
```

The Camoufox worker is the `camoufox` Compose profile:

```sh
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 \
  --profile camoufox up -d storage api worker-camoufox
```

Run `worker` or `worker-camoufox`, not both. For the sandbox, add
`--engine chromium`:

```sh
scripts/network-sandbox offline --engine chromium
scripts/network-sandbox live --engine chromium --url https://www.auto24.ee/soidukid/<listing id>
```

The live capture script reveals with the extension on Chromium, so the live
sandbox run attempts a solve.

WebSockets are blocked. A local rule-only guard extension
(`src/auto24_service/websocket_guard/`) is copied per session, and before the
first navigation a loopback canary must be refused or the launch fails.

To benchmark both engines, run the benchmark module twice on the same
`benchmarks/urls.txt`, once in each image:

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
docker compose --env-file "$ENV_FILE" -p auto24 --profile camoufox run --rm \
  -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker-camoufox \
  -m auto24_service.captcha_benchmark --engine camoufox --mode fresh \
  --listings /app/benchmarks/urls.txt --label <name>-camoufox --revision "$(git rev-parse HEAD)"

docker compose --env-file "$ENV_FILE" -p auto24 run --rm \
  -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker \
  -m auto24_service.captcha_benchmark --engine chromium --mode fresh shared \
  --listings /app/benchmarks/urls.txt --label <name>-chromium --revision "$(git rev-parse HEAD)"
```

`--engine both` cannot run in either image. The Chromium image has the Camoufox
Python package but neither the Camoufox browser nor the solver files, and the
`worker-camoufox` image has no Patchright. Each engine's gate is computed independently
(`camoufox/fresh` in one run, `chromium/fresh` in the other), and the two
summaries stand in for the side-by-side summary of C2 step 2.

To run the Chromium tests on the `x86_64` server, build the test target for
amd64, then run the subset (offline, no pull):

```sh
docker buildx build -f Dockerfile.chromium --target test --platform linux/amd64 \
  --build-context browser_assets="$HOME/.cache/auto24/browser-assets" \
  --load -t auto24-extraction-service:chromium-test .
docker run --rm --platform linux/amd64 --network none --pull=never -v "$PWD:/app:ro" -w /app \
  -e PYTHONPATH=/app/src:/app -e PYTHONDONTWRITEBYTECODE=1 auto24-extraction-service:chromium-test \
  python -m pytest -q -p no:cacheprovider tests/test_browser_chromium.py \
  tests/test_patchright_redirect_patch.py tests/test_extension_wait.py tests/test_real_extension_smoke.py
```

To run the whole Python suite, use the sandbox image (offline, no pull):

```sh
docker run --rm --network none --pull=never -v "$PWD:/app:ro" -w /app \
  -e PYTHONPATH=/app/src:/app -e PYTHONDONTWRITEBYTECODE=1 --entrypoint python \
  auto24-extraction-service:sandbox -m pytest -q -p no:cacheprovider -n 3
```

`-n 3` runs three pytest-xdist workers and takes about 5 minutes; one worker
takes about 10. Do not raise it: from four workers up, the Camoufox tests slow
down enough that the CAPTCHA and reveal tests hit their time limits. Each worker gets its
own temp dir (`tests/conftest.py`), so Chromium leftover sweeps never see
another worker's profiles. The
CAPTCHA driver and reveal tests cap Camoufox's cursor moves at 0.1 s
(`browser._HUMANIZE`) and shorten the value wait after the widget goes, so most
browser tests take 5 to 15 s. Rebuild the sandbox image after a change to the
test packages in `compose.sandbox.yaml`.

### Updating Chromium

Chromium opens real websites, so security fixes matter. Bump Chromium and
Patchright together at least monthly, and soon after any Chromium security
release. A bump updates the hash pins in `vendor/browser-assets/` and
`scripts/fetch-browser-assets`, then reruns the pin checks
(`scripts/fetch-browser-assets`), the real-extension smoke test on both
architectures, the Chromium test suite and `scripts/network-sandbox offline
--engine chromium`. Merge only when all pass.

## Back up and restore

Stop submissions and processing before copying the complete volume. This also
closes storage's Turso connection. The commands below use Compose project
`auto24`; change the project and volume names together if you chose another
project name. Keep the archive in a private directory outside the checkout.

```sh
umask 077
ENV_FILE="$HOME/.config/auto24/auto24.env"
BACKUP_DIR="$HOME/.local/share/auto24/backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
ARCHIVE="auto24-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose --env-file "$ENV_FILE" -p auto24 stop api worker storage
docker run --rm -v auto24_turso_data:/data:ro -v "$BACKUP_DIR:/backup" \
  --entrypoint tar python:3.12-slim-bookworm -czf "/backup/$ARCHIVE" -C /data .
docker compose --env-file "$ENV_FILE" -p auto24 up -d
```

Restore to a fresh named volume while its storage service is stopped. This
example starts a second Compose project on port 8002 to verify the restored
history without replacing the original volume:

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
BACKUP_DIR="$HOME/.local/share/auto24/backups"
set -a; . "$ENV_FILE"; set +a
docker volume create auto24-restore_turso_data
docker run --rm -v auto24-restore_turso_data:/data -v "$BACKUP_DIR:/backup:ro" \
  --entrypoint tar python:3.12-slim-bookworm -xzf "/backup/$ARCHIVE" -C /data
API_BIND=127.0.0.1:8002 docker compose --env-file "$ENV_FILE" \
  -p auto24-restore up -d
curl -sS http://127.0.0.1:8002/v1/jobs/JOB_ID -H "X-API-Key: $PUBLIC_API_KEY"
```

Check that the restored job ID, status, and `parsed_at` match the source. Stop
the restored project with:

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
docker compose --env-file "$ENV_FILE" -p auto24-restore down
```

`down` without `-v` keeps its volume; deleting a data volume deletes its job
history. Retain the archive separately.

## Listing dashboard

Open `/et` or `/en`. The browser submits `{listingUrl}` to `POST /api/listings`.
The app validates/canonicalizes the URL, calls the service once, returns
`{jobId}`, and creates an HttpOnly, SameSite=Lax access cookie for that job.
The private dashboard at `/[locale]/a/[jobId]` polls `GET /api/listings/[jobId]`.
The service key stays on the server. All API responses disable caching, service
requests have a 10-second deadline, and upstream redirects are rejected.

The service durably stores jobs/results; the per-job signed cookie associates
this browser with its submission for 24 hours. Refresh and additional tabs can
resume the same job without another POST. Multiple jobs retain separate cookies.
Clearing/expiring cookies or rotating the signing secret loses browser access;
sharing the dashboard URL alone grants no access. Browser cookie limits eventually
cap how many jobs can be retained. Analysis reports use Supabase persistence and
their own private access links, described below.

## Private analysis reports

Private reports accept buyer/seller supplements to the captured listing.
Configure the Supabase URL, service role key, and independent
cookie secret in `.env.local`. The worker uses the same application configuration
and a unique `WORKER_ID`. Apply pending migrations with `pnpm supabase migration up
--local` on an existing local database. Preserve its data and private storage.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm worker
```

Keep the web server and analysis worker running in separate terminals.
`pnpm dev` starts only the web server; the Compose Python worker handles
scraping and does not consume analysis jobs. For a shared development database,
restrict the worker to reports created at or after a chosen timestamp:

```sh
pnpm worker --created-after 2026-10-05T08:14:00Z
```

This also processes future reports and their supplements, while leaving older
reports untouched. Without the flag the worker consumes the whole analysis queue.

Open `/et` or `/en`, submit a listing, then open its report from the dashboard.
The dashboard stays at `/[locale]/a/[jobId]`; the report uses
`/[locale]/r/[publicId]`. The initial report link exchanges its private token
fragment for an HttpOnly access cookie. The URL alone grants no access. Report
reads and uploads require that cookie and disable shared caching. Seller answers,
buyer notes, screenshots, and photos create a new run at the same report URL.
Uploaded PDFs remain private and unread.

`AUTO24_FETCH_ENABLED=false` enables manual continuation without submitting a
scraper job. Recoverable capture failures also offer manual continuation. Saved
captures feed reports directly. The analysis worker does not discover external
sources; official checks remain `not_checked` until an authorized integration
supplies applicable records.

Reviewer settings are server-only. Set `DATA_REVIEW_ENABLED=false` for an explicit
baseline-only report. For review, configure `OPENAI_API_KEY`, `DATA_REVIEW_MODEL`,
and exact model capabilities in `DATA_REVIEW_CAPABILITIES`. The server rejects
unknown or unsupported models/settings instead of substituting another model.
Production review always resolves separate text, image, and final passes. Text
and final use the configured text settings. The image pass is fixed to the
Codex `gpt-6-luna` model, defaults to `xhigh`, and accepts a lower explicit
`DATA_REVIEW_IMAGE_REASONING_EFFORT`. It requires an explicit
`codex/gpt-6-luna` capability declaration including `xhigh`; unsupported or
higher image effort leaves image review unavailable while preserving valid text
work and marking overall review incomplete.

The worker pins inputs, locale, model/settings, image hashes, and composed prompts
before starting. Prompt sources live in `src/insights/prompts/`. Each validated
pass result commits before final review starts. Retries reuse committed success;
a superseded run cannot publish final conclusions. A model's interpretation does
not confirm a seller claim, and the existing deterministic verdict policy remains
in charge. Changing interface language leaves saved conclusions in their original
report language.

Run application checks with:

```sh
pnpm test
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm build
```

Run integration tests against a disposable local Supabase project with no live
worker or unrelated queued jobs. Global fairness tests require an empty queue.
Never clear an existing development database to satisfy those tests.
Passing a JSON schema does not prove that a model
interpreted the car evidence correctly.

For a local Codex reviewer, set `DATA_REVIEW_PROVIDER=codex`, configure the text
model and its exact capabilities under the `codex` key, and run `codex login` on
the worker machine. The production image capability declaration is required as
shown in `.env.example`. `DATA_REVIEW_CODEX_COMMAND` can point to the installed
executable. This uses your Codex allowance without a separate OpenAI API key.
Each pass runs in a temporary, read-only session with tools disabled and validated
structured output; the configured model still runs remotely. Use this provider
for the local developer workflow, with the worker running under your trusted
account.

After changing reviewer settings, start a new pinned run at the same report URL:

```sh
NODE_OPTIONS=--conditions=react-server pnpm tsx scripts/rereview.ts PUBLIC_ID
```

Review snapshots and publication payloads have explicit size limits (1 MiB for the persisted final request/publication). Oversized cumulative input leaves review incomplete without truncating evidence or silently dropping observations. A schema-valid individual pass does not guarantee every maximum-sized aggregate fits.


## Report access and limitations

Reports can be saved on this device for 30 days, updated, and removed from the
report page. The front page lists saved reports. Save and Update restart the
saved copy's lifetime and renew the browser's access cookie for 30 days. Losing
that cookie does not remove a saved copy. Opening a report still needs a
connection until checkpoint 9 adds offline opening. The viewing actions do not
retain checkbox marks. A running analysis worker processes new reviews and
supplements.

To check expiry locally, set `NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES=2` in
`.env.local`, restart the app, save a report, then reload the front page after
three minutes. The saved copy is removed when read after expiry. This override
only applies outside production and never shortens the access cookie's 30-day
lifetime. Remove the override and restart when finished testing. Saved report
data stays in this browser's IndexedDB; clearing site storage removes it.
Saving also needs localStorage for a small removal marker per report. These
markers contain no report contents and prevent a pending save in another tab
from restoring a removed copy. If that storage is blocked, saving is unavailable.

Keep the original private report link when opening the same analysis in a second
browser. Its `#access=` fragment exchanges for that browser's private access
cookie and disappears from the address bar. A copied address without the fragment
grants no access in a new browser. Refreshing an authorized report does not start
a new analysis. Submitting a listing again creates a separate report.

The interface follows its `/et` or `/en` route. Saved model conclusions retain
the language pinned when the report run started. Change the route to change the
interface without changing those saved conclusions.

## Live diagnostics, checkpoint 1

Set the server-only `LIVE_DIAGNOSTICS_ENABLED=true` and restart the Next.js app
to show Live diagnostics on private reports. The default is false. Report access
cookies are still required, and diagnostics responses are private and uncached.
Turn the flag off to remove the entry point and return 404 from its endpoints.
No database migration is needed for this checkpoint.

The drawer reads existing review snapshots, executions, attempts, and job state.
It shows text, photo, and final review progress plus saved intermediate findings.
Findings remain provisional until the final assessment commits. An attempt
duration includes reviewer preparation and persistence. It is not pure provider
latency. Photo calls overlap, so their durations are not summed into report wait.
Reused results retain their original completion time and source run; they do not
represent a new call. Missing or historical measurements say Not recorded.

The drawer refreshes while open and visible, with one request at a time and at
least three seconds between regular refreshes. Transient errors back off, and
Retry now requests a fresh snapshot. Opening a committed result loads it lazily.
The drawer keeps checking for a new run after completion, including PDF updates.
An expired worker lease is shown as stale rather than an invented failure.

Checkpoint 1 adds read requests only. It does not collect new phase measurements
or change provider calls, retry limits, photo concurrency, or publication rules.
Capture and photo-preparation timings, PDF processing detail, earlier-run
selection, and JSON export belong to later checkpoints.

## Live diagnostics, Auto24 capture timings

The same `LIVE_DIAGNOSTICS_ENABLED` flag also controls capture timing collection
in the extraction service. Compose passes it to the `storage` and `worker`
containers as `${LIVE_DIAGNOSTICS_ENABLED:-false}`, so set it in the shell that
runs `docker compose`, not only in `.env.local`. After changing it, rebuild and
restart the stack:

```sh
LIVE_DIAGNOSTICS_ENABLED=true docker compose --env-file "$ENV_FILE" -p auto24 up --build -d
```

With the flag on, the worker records each browser phase and parsing, and the
storage service records queue waits, retry waits and saving the result. Reopening
an existing Turso volume adds the `diagnostic_spans` table and keeps every job.
With the flag off, no span rows are written and capture behaves as before. A
storage outage during span writes never changes the capture result.

In the app, the listing page shows Live diagnostics under the report button, and
on a failed capture. The report drawer shows the same capture timings above the
photo timings. Listings captured before this change, or by a service without
the flag, say Not recorded. Reports made from pasted text say capture timings
do not apply.

To repeat the overhead check, run `python scripts/measure_capture_overhead.py`
in a Python environment with the service and its dependencies installed. It needs
no Docker and makes no Auto24 request.

## Saved reports offline

Run `pnpm build && pnpm start` for the production service worker. Open a report online and choose to save it on this device before disconnecting. Saved copies expire after the configured retention period; they live in this browser's storage and can disappear if the browser clears site data. Both Estonian and English report addresses work from the saved copy. Checking a new listing still needs a connection.

For a phone on your development machine's app, expose the server through HTTPS, for example `cloudflared tunnel --url http://localhost:3000`, then open the printed HTTPS address on the phone. Service workers require a secure context: localhost is allowed on the development computer, but a phone's plain HTTP LAN address is not. Save and reopen the report on that same HTTPS origin before testing airplane mode.

`pnpm test:e2e` builds and starts production on port 3109, then runs Chromium with real service-worker requests and browser offline mode. Install its browser first with `pnpm playwright install chromium`. Keep port 3109 free.

Browsers without Web Locks use the worker queue to remove individual deleted or expired report shells. They skip direct cleanup across build caches and retain an empty service worker/static cache, because destructive cleanup could erase a concurrent save in another tab. Data-free shells from an absent or failed worker may remain; report JSON is still removed.
