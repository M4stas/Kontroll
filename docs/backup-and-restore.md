# Backup and restore

## Back up and restore

Job history lives in the `turso_data` volume. Background check PDFs live in the `background_checks` volume, which `worker-mnt` and `worker-auto24` write and the API serves read-only. Back up both volumes together so each job still finds its PDF.

Stop the services before copying the volumes, and keep the archives outside the checkout.

```sh
umask 077
ENV_FILE="$HOME/.config/auto24/auto24.env"
BACKUP_DIR="$HOME/.local/share/auto24/backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose --env-file "$ENV_FILE" -p auto24 stop api worker-auto24 worker-mnt storage
docker run --rm -v auto24_turso_data:/data:ro -v "$BACKUP_DIR:/backup" \
  --entrypoint tar python:3.12-slim-bookworm -czf "/backup/auto24-$STAMP.tar.gz" -C /data .
docker run --rm -v auto24_background_checks:/data:ro -v "$BACKUP_DIR:/backup" \
  --entrypoint tar python:3.12-slim-bookworm \
  -czf "/backup/auto24-background-checks-$STAMP.tar.gz" -C /data .
docker compose --env-file "$ENV_FILE" -p auto24 up -d
```

To verify a restore, load both archives into a second project on port 8002. Check that the job ID, status and `parsed_at` match the source, and that the job's PDF downloads. Run this in the same shell as the backup, or set `STAMP` to the archives' timestamp first.

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
BACKUP_DIR="$HOME/.local/share/auto24/backups"
set -a; . "$ENV_FILE"; set +a
docker volume create auto24-restore_turso_data
docker volume create auto24-restore_background_checks
docker run --rm -v auto24-restore_turso_data:/data -v "$BACKUP_DIR:/backup:ro" \
  --entrypoint tar python:3.12-slim-bookworm -xzf "/backup/auto24-$STAMP.tar.gz" -C /data
docker run --rm -v auto24-restore_background_checks:/data -v "$BACKUP_DIR:/backup:ro" \
  --entrypoint tar python:3.12-slim-bookworm \
  -xzf "/backup/auto24-background-checks-$STAMP.tar.gz" -C /data
API_BIND=127.0.0.1:8002 docker compose --env-file "$ENV_FILE" \
  -p auto24-restore up -d storage api
curl -sS http://127.0.0.1:8002/v1/jobs/JOB_ID -H "X-API-Key: $PUBLIC_API_KEY"
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8002/v1/jobs/JOB_ID/background-check/pdf -H "X-API-Key: $PUBLIC_API_KEY"
docker compose --env-file "$ENV_FILE" -p auto24-restore down
```

Pick a `JOB_ID` with a fetched PDF so the second `curl` prints `200`. `down -v` would delete the job history and PDFs in those volumes.
