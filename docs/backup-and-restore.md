# Backup and restore

## Back up and restore

Stop the services before copying the volume, and keep the archive outside the checkout.

```sh
umask 077
ENV_FILE="$HOME/.config/auto24/auto24.env"
BACKUP_DIR="$HOME/.local/share/auto24/backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
ARCHIVE="auto24-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose --env-file "$ENV_FILE" -p auto24 stop api worker-auto24 storage
docker run --rm -v auto24_turso_data:/data:ro -v "$BACKUP_DIR:/backup" \
  --entrypoint tar python:3.12-slim-bookworm -czf "/backup/$ARCHIVE" -C /data .
docker compose --env-file "$ENV_FILE" -p auto24 up -d
```

To verify a restore, load it into a second project on port 8002 and check that the job ID, status and `parsed_at` match the source:

```sh
ENV_FILE="$HOME/.config/auto24/auto24.env"
BACKUP_DIR="$HOME/.local/share/auto24/backups"
set -a; . "$ENV_FILE"; set +a
docker volume create auto24-restore_turso_data
docker run --rm -v auto24-restore_turso_data:/data -v "$BACKUP_DIR:/backup:ro" \
  --entrypoint tar python:3.12-slim-bookworm -xzf "/backup/$ARCHIVE" -C /data
API_BIND=127.0.0.1:8002 docker compose --env-file "$ENV_FILE" \
  -p auto24-restore up -d storage api
curl -sS http://127.0.0.1:8002/v1/jobs/JOB_ID -H "X-API-Key: $PUBLIC_API_KEY"
docker compose --env-file "$ENV_FILE" -p auto24-restore down
```

`down -v` would delete the job history in that volume.

