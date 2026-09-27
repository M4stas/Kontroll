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
