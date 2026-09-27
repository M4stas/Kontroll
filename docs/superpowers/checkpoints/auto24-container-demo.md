# Checkpoint 2: separate Turso container demo

Run date: 2026-09-27. This is a local Docker demo of the code available after Checkpoint 2. The production Compose deployment and public API belong to later checkpoints.

## Containers and data boundary

- Image: `auto24-extraction-service:checkpoint2-demo`, built from the current branch.
- Network: `auto24-checkpoint2-demo`.
- Storage container: `auto24-checkpoint2-storage`, running `uvicorn auto24_service.storage_api:app` with `TURSO_DB_PATH=/data/auto24.db` and one worker process.
- Persistent Docker volume: `auto24-checkpoint2-data`, mounted only by storage at `/data`.
- Browser worker: `auto24-checkpoint2-worker`, run once as a separate container on the network, then removed with `--rm`. It had no database mount.
- Storage has no published host ports (`HostConfig.PortBindings={}`). The private API uses an internal key supplied from a mode-600 temporary env file; the key is omitted here.

The storage health endpoint returned `200 {"status":"ok"}`. Inside `/data`, Turso created `auto24.db` and `auto24.db-wal`. `pyturso` was imported from the storage image's installed Python package.
An unauthenticated `GET /internal/jobs/94af4af6-c58e-4424-a0cd-84bb5f911864` returned `401 {"detail":"Invalid internal key"}`.

## Real listing result

Submitted `https://www.auto24.ee/soidukid/4344096` through authenticated `POST /internal/jobs`. The storage container returned HTTP 201 and:

```json
{"job_id":"94af4af6-c58e-4424-a0cd-84bb5f911864","status":"queued","submitted_at":"2026-09-27T18:04:58.965124Z","parsed_at":null}
```

Ran the separate worker with:

```sh
docker run --rm --name auto24-checkpoint2-worker \
  --network auto24-checkpoint2-demo --env-file <redacted-env-file> \
  -e STORAGE_URL=http://storage:8001 --entrypoint python \
  auto24-extraction-service:checkpoint2-demo -m auto24_service.worker --once
```

It logged successful claim and completion requests. The authenticated `GET /internal/jobs/94af4af6-c58e-4424-a0cd-84bb5f911864` returned a completed snapshot with:

```json
{
  "job_id": "94af4af6-c58e-4424-a0cd-84bb5f911864",
  "status": "completed",
  "parsed_at": "2026-09-27T18:05:34.695202Z",
  "listing": {
    "listing_id": "4344096",
    "title": "Skoda Enyaq 195kW",
    "year": 2022,
    "mileage_km": 46800,
    "price": {"amount": 41500, "currency": "EUR"}
  },
  "warnings": ["missing_make", "missing_model"]
}
```

The full response is in `auto24-container-demo-listing.json`: 949 characters of seller description, seven equipment groups, 16 technical specifications, and 19 photo URLs. The separate make/model fields are null because the page did not provide reliable values for them; the title contains the displayed car name.

## Container replacement and persistence proof

Stopped and removed the original storage container, ID `33b94ca54256ade8d77b9d690e0e16edb4ce4546c34a280993fb7e9f7fd62e59`. Docker confirmed that volume `auto24-checkpoint2-data` still existed. Started a new storage container from the same image with the same volume; its ID is `188f67de99a525fcac1e5d3139286ecce2767e18cb72a13be8c0d3e3b9da7128`.

The new container returned the same job through its private API. Canonical JSON comparison before and after replacement returned:

```json
{
  "same_job_id": true,
  "same_status": true,
  "same_parsed_at": true,
  "same_full_response": true,
  "before_sha256": "7c5f0360775ba2ca8a3e9802b0ace124273bbbcdc395a4bfbb9f39bf9e8ca6cd",
  "after_sha256": "7c5f0360775ba2ca8a3e9802b0ace124273bbbcdc395a4bfbb9f39bf9e8ca6cd",
  "parsed_at": "2026-09-27T18:05:34.695202Z"
}
```

At the end of the demo, the replacement `auto24-checkpoint2-storage` container remains running with the named volume and no published host port. This proves the stored snapshot survives replacing the storage application container while retaining the volume. It does not yet demonstrate the planned production Compose setup or backup/restore procedure.
