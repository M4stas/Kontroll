# Auto24 extraction service

Submit an Auto24 passenger-car listing URL, then poll for a stored result. The
worker uses Camoufox to capture the public page. The storage service alone opens
the embedded Turso database; the API and worker reach it over the private Compose
network. The database lives in the `turso_data` named volume.

## Start

Create a private environment file outside this checkout. Choose independent,
random public and internal keys, for example:

```sh
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
measure progress during an in-flight capture. The same image still supports the
manual one-link command:

```sh
docker build -t auto24-extraction-service:manual .
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

## Car dashboard app (Checkpoint 1)

The small Next.js app connects to the existing service. It needs Node 24 and no
analysis worker, Luna, Supabase, or app database for this checkpoint. Start the
service as described above, then configure `.env.local` with the three app-only
variables shown in `.env.example`. `AUTO24_SERVICE_API_KEY` must match the
service's public API key. Keep both keys and `ANALYSIS_COOKIE_SECRET` private;
none are browser configuration.

```sh
npm ci
npm run dev
```

Open `/et` or `/en`. The browser submits `{listingUrl}` to `POST /api/listings`.
The app validates/canonicalizes the URL, calls the service once, returns
`{jobId}`, and creates an HttpOnly, SameSite=Lax access cookie for that job.
The private dashboard at `/[locale]/a/[jobId]` polls `GET /api/listings/[jobId]`.
The service key stays on the server. All API responses disable caching, service
requests have a 10-second deadline, and upstream redirects are rejected.

The service durably stores jobs/results; the per-job signed cookie associates
this browser with its submission for 24 hours. Refresh and additional tabs can
resume the same job without another POST. Multiple jobs retain separate cookies.
There is no new app database or migration. Clearing/expiring cookies or rotating
the signing secret loses browser access; sharing the dashboard URL alone grants
no access. Browser cookie limits eventually cap how many jobs can be retained.
This is the explicit minimal persistence choice for Checkpoint 1. Later analysis
persistence is deferred.

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Automated foundation tests stub service HTTP; the checkpoint's live browser demo
is recorded separately and must use the actual extraction service.


## Private analysis reports, checkpoint 2

Checkpoint 2 adds private reports and buyer/seller supplements to the captured
listing dashboard. Configure the Supabase URL, service role key, and independent
cookie secret in `.env.local`. The worker uses the same application configuration
and a unique `WORKER_ID`. Apply pending migrations with `npx supabase migration up
--local` on an existing local database. Preserve its data and private storage.

```sh
npm ci
npm run dev
npm run worker
```

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
Unified mode uses one model for separate text, individual image, and final passes.
Split mode uses the text/image overrides shown in `.env.example`; final review
uses the text model. Invalid image settings preserve valid text work but leave
the overall review incomplete.

The worker pins inputs, locale, model/settings, image hashes, and composed prompts
before starting. Prompt sources live in `src/insights/prompts/`. Each validated
pass result commits before final review starts. Retries reuse committed success;
a superseded run cannot publish final conclusions. A model's interpretation does
not confirm a seller claim, and the existing deterministic verdict policy remains
in charge. Changing interface language leaves saved conclusions in their original
report language.

Run current delivery checks with:

```sh
npm test
npm run test:integration
npm run lint
npm run typecheck
npm run build
```

Integration tests use the running local Supabase instance, disposable analyses,
and scoped leases. Run them while the production worker is stopped so it cannot
consume test jobs. The evaluation guide under
`docs/superpowers/checkpoints/reviewer-evaluation-guide.md` explains the opt-in
model comparison and human scoring. Passing a JSON schema does not prove that a
model interpreted the car evidence correctly.

For a local Codex reviewer, set `DATA_REVIEW_PROVIDER=codex`, configure the model
and its exact capabilities under the `codex` key, and run `codex login` on the
worker machine. `DATA_REVIEW_CODEX_COMMAND` can point to the installed executable.
This uses your Codex allowance without a separate OpenAI API key. Each pass runs
in a temporary, read-only session with tools disabled and validated structured
output; the configured model still runs remotely. Use this provider for the local
developer workflow, with the worker running under your trusted account.

After changing reviewer settings, start a new pinned run at the same report URL:

```sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/rereview.ts PUBLIC_ID
```

Review snapshots and publication payloads have explicit size limits (1 MiB for the persisted final request/publication). Oversized cumulative input leaves review incomplete without truncating evidence or silently dropping observations. A schema-valid individual pass does not guarantee every maximum-sized aggregate fits.
