# Local development

## Run the whole project locally

`pnpm kontroll` runs the steps below, then starts the app and the worker in one terminal. It is safe to repeat, because it never resets the database and only fills empty values in `.env.local`. `pnpm kontroll --setup-only` skips starting the app.

Manual steps, with Node 24 and Docker running:

1. Run `pnpm install --frozen-lockfile`. Run `corepack enable` once if `pnpm` is not found.
2. Start the [Auto24 stack](#auto24-extraction-setup).
3. Run `pnpm supabase start`. On an existing database, run `pnpm supabase migration up --local`. Never reset it. All worktrees share this stack. Remove a disposable stack with `pnpm supabase stop --no-backup --project-id <id>`.
4. Copy `.env.example` to `.env.local` if it is missing, then set:
   - `AUTO24_SERVICE_URL=http://127.0.0.1:8000`
   - `AUTO24_SERVICE_API_KEY` to the service's `PUBLIC_API_KEY`
   - `ANALYSIS_COOKIE_SECRET` to at least 32 random characters (`openssl rand -hex 32`)
   - a unique `WORKER_ID` per worker
   - `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `API_URL` and `SERVICE_ROLE_KEY` from `pnpm supabase status -o env`
5. Configure the [reviewer](#private-analysis-reports), or set `DATA_REVIEW_ENABLED=false` for a baseline-only report.
6. Run `pnpm dev` and `pnpm worker` in separate terminals.

The app is at http://localhost:3000/en and `/et`, or on the port Next.js prints. Port 8000 is the extraction API, which returns 401 without `X-API-Key` on every path except `/health`.

To open the dev server from another device, list its host names or IPs, comma-separated, in `DEV_ALLOWED_ORIGINS` in `.env.local` and restart `pnpm dev`.

In `pnpm dev`, browsers send uncaught errors, unhandled rejections and `console.error` calls to the dev server, capped at 50 per page load. They appear in its terminal as `[client error]`, `[client unhandledrejection]` or `[client console.error]`, so phone errors are readable there. Production builds leave this out.

Read [Chromium engine setup](chromium-engine.md) to build or test Chromium, [backup and restore](backup-and-restore.md) to preserve or restore job history, and [live diagnostics](live-diagnostics.md) to configure report and capture timings.

## Auto24 extraction setup

The worker captures listings with Chromium; Camoufox is opt-in. Only the storage service opens the Turso database, which lives in the `turso_data` volume. Compose sets `STORAGE_URL` and `TURSO_DB_PATH`.

Create a private env file outside the checkout and start the stack:

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

Run the three fetch scripts before any `docker compose ... build`, because the builds read their caches. Other project names, such as `auto24-restore`, need `-p`. The worker health check only verifies that the process is alive.

To capture one link by hand with the `:compose` image:

```sh
scripts/fetch-captcha-solver
docker build \
  --build-context captcha_solver="$HOME/.cache/auto24/captcha-solver/current" \
  -t auto24-extraction-service:manual .
docker run --rm auto24-extraction-service:manual https://www.auto24.ee/soidukid/4344096
```

### Storage tests

Tests that import the job store or storage API need `turso`, which the invisible test image doesn't have. This image adds pytest to the compose image and runs them offline:

```sh
docker build -f Dockerfile.storage-test -t auto24-extraction-service:storage-test .
scripts/pytest-service --image storage --network none tests/test_lookup_availability.py
```

### Invisible lookup worker

`worker-mnt` runs background checks only and starts with the default stack. It takes every lookup by default. Listing captures stay on `worker-auto24`.

```sh
docker compose build worker-auto24 worker-mnt
docker build -f Dockerfile.invisible --target test -t auto24-extraction-service:invisible-test .
scripts/network-sandbox offline --engine invisible
scripts/pytest-service --image invisible --network none
```

The sandbox needs the local `auto24-netlog:sandbox` image and accepts `invisible` only in offline mode. It should print "offline background check: fake MNT search fetched a fake PDF" and PASS with no contacted hosts.

`CHROMIUM_LOOKUPS=true` in the stack's env file, after recreating `worker-auto24`, lets Chromium claim lookups too. The default is `false`, because MNT rejected Chromium's reCAPTCHA tokens in every live check on 2026-10-29 and 2026-10-30.

For stopped or busy lookup workers, see [lookup availability and deadlines](superpowers/specs/2026-10-22-transpordiamet-background-check-design.md#lookup-availability-and-deadlines).

## Submit and poll

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
set -a; . "$ENV_FILE"; set +a
curl -sS -i -X POST http://127.0.0.1:8000/v1/jobs \
  -H "X-API-Key: $PUBLIC_API_KEY" -H 'Content-Type: application/json' \
  --data '{"url":"https://www.auto24.ee/soidukid/4344096"}'
curl -sS -i http://127.0.0.1:8000/v1/jobs/JOB_ID \
  -H "X-API-Key: $PUBLIC_API_KEY"
```

Use a current public passenger-car URL. Submitting returns 202 with `job_id`, `status` and `status_url`. Polling returns `queued`, `running`, `completed` or `failed`. A failed job has an `error.code`: `listing_gone`, `access_blocked`, `unsupported_vehicle_type`, `parse_failed` or `temporary_failure`.

| Status | Meaning |
| --- | --- |
| 400 | Unsupported URL |
| 401 | Missing or wrong API key |
| 404 | Unknown job ID |
| 503 | Storage unavailable |

## Registration reveal

The worker reveals the registration number and VIN by solving the listing's reCAPTCHA. On Chromium the extension solves it. On Camoufox the solver files do, which `scripts/fetch-captcha-solver` fetches from the `captcha-solver-assets` branch, verifies and caches under `~/.cache/auto24/captcha-solver/`.

- `REVEAL_FORCE_FAILURE=true` makes every reveal fail. It works only when `AUTO24_ENV` is `development` or `test`.
- `CAPTCHA_LOOKUP_ENABLED=true` turns the stale perceptual-hash lookup back on. The default is `false`, and any other value stops the worker at startup.

### Check network traffic

The sandbox logs every DNS query and outgoing connection from the capture container.

```sh
INTERNAL_API_KEY=test PUBLIC_API_KEY=test docker compose -p auto24 build
scripts/network-sandbox offline
scripts/network-sandbox live --url https://www.auto24.ee/soidukid/<listing id>
```

Offline mode passes only when nothing leaves the container. Live mode makes one real capture and passes when every host is `www.auto24.ee`, `www.google.com` or `www.gstatic.com`. It prints statuses, never revealed values.

Reports go to `sandbox-reports/<mode>-<UTC time>/`, which Git ignores. `live --debug` adds masked screenshots and `events.jsonl`. Keep that folder local.

### Benchmark

Put one listing URL per line in `benchmarks/urls.txt`, then run each engine in its own image. `--engine both` cannot run in either image. The deadline is a two-minute lease minus 15 seconds.

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
docker compose --env-file "$ENV_FILE" -p auto24 --profile camoufox run --rm \
  -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker-camoufox \
  -m auto24_service.captcha_benchmark --engine camoufox --mode fresh \
  --listings /app/benchmarks/urls.txt --label <name>-camoufox --revision "$(git rev-parse HEAD)"

docker compose --env-file "$ENV_FILE" -p auto24 run --rm \
  -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker-auto24 \
  -m auto24_service.captcha_benchmark --engine chromium --mode fresh shared \
  --listings /app/benchmarks/urls.txt --label <name>-chromium --revision "$(git rev-parse HEAD)"
```

| `--mode` | Runs |
| --- | --- |
| `fresh` | A new profile or browser for each capture. Only this mode decides the exit code. |
| `saved` | One kept profile, with the worker's reset rules. |
| `shared` | Chromium only. Every listing opens a new page of one browser session. |

The default is `fresh saved`, and `both` means the same. A `*/fresh` result passes with at least 8 of 10 reveals on attempt 1, and a capture error counts as a failure. A run with no `*/fresh` result exits 1. A retry in `shared` reuses the session, so read it as "does a warm session help?", not as a like-for-like retry count.

Reports go to `benchmarks/<name>-<UTC time>/`, which Git ignores. Build from the revision passed to `--revision`. A listed value or absent field does not prove a hidden-field reveal. `--debug` saves masked screenshots and `events.jsonl` per reveal. Keep them local.

## Listing dashboard

The browser posts `{listingUrl}` to `POST /api/listings` and gets `{jobId}` and a signed HttpOnly cookie for that job, valid for 24 hours. `/[locale]/a/[jobId]` polls `GET /api/listings/[jobId]`. Service requests have a 10-second deadline. The URL alone grants no access, and clearing cookies or rotating the secret loses access.

## Private analysis reports

`pnpm dev` starts only the web server, and the Compose worker does not consume analysis jobs, so also run `pnpm worker`. On a shared database, leave older reports alone with:

```sh
pnpm worker --created-after 2026-10-05T08:14:00Z
```

`AUTO24_FETCH_ENABLED=false` skips the scraper and offers manual continuation, as do recoverable capture failures. [How it works](how-it-works.md#reports-and-access) covers report URLs, supplements and taustakontroll PDFs.

### Reviewer

Reviewer settings are server-only. Set `DATA_REVIEW_MODEL` and exact capabilities in `DATA_REVIEW_CAPABILITIES`. The server rejects unknown models and settings instead of substituting another.

- **Codex, the default in `.env.example`.** If `DATA_REVIEW_PROVIDER` is unset, the server uses OpenAI. Declare the text model under the `codex` key and run `codex login` on the worker machine. `DATA_REVIEW_CODEX_COMMAND` can point to the executable. No OpenAI API key is needed.
- **OpenAI.** Set `DATA_REVIEW_PROVIDER=openai` and `OPENAI_API_KEY`, and declare the model under the `openai` key. The image pass still needs Codex.

Review has text, image and final passes. The image pass always uses Codex `gpt-6-luna`, and needs a `codex/gpt-6-luna` capability including `xhigh`. `DATA_REVIEW_IMAGE_REASONING_EFFORT` can lower its effort. An unsupported image setting marks review incomplete and keeps valid text work. Oversized input also leaves review incomplete and truncates nothing. The limits are 8 MiB for a Codex request and 1,000,000 bytes for the saved review.

Prompts live in `src/insights/prompts/`. After changing reviewer settings, start a new run at the same report URL:

```sh
NODE_OPTIONS=--conditions=react-server pnpm tsx scripts/rereview.ts PUBLIC_ID
```

### Checks

The commands below are the broad local checks. For the no-mistakes Test step's checks and time budget, follow [the repository configuration](../.no-mistakes.yaml).

```sh
pnpm test
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm build
```

Run integration tests against a disposable Supabase project with no live worker. The fairness tests need an empty queue. Never clear an existing development database for them.

## Report access and limitations

- Saved copies last 30 days, and Save and Update restart that period and renew the access cookie. They live in IndexedDB, so clearing site storage removes them. Saving also needs localStorage, and is unavailable if it is blocked.
- To test expiry, set `NEXT_PUBLIC_OFFLINE_EXPIRY_MINUTES=2` in `.env.local`, restart, save a report and reload the front page after three minutes. The override has no effect in production. Remove it afterwards.
- In a second browser, use the original private link. Its `#access=` fragment grants access, and an address without it does not.
- Refreshing a report starts no new analysis. Submitting a listing again creates a separate report.
- The interface follows the `/et` or `/en` route. Saved model conclusions keep the language pinned when the run started.

## Saved reports offline

Run `pnpm build && pnpm start` for the production service worker, then save a report while online.

Service workers need a secure context, so a phone needs HTTPS. Run `cloudflared tunnel --url http://localhost:3000`, then save and reopen the report on the printed address before testing airplane mode.

`pnpm test:e2e` builds and runs production on port 3109, which must be free, with real service-worker requests. Install its browser first with `pnpm playwright install chromium`.
