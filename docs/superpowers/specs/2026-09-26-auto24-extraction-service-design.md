# Auto24 passenger-car extraction service design

Date: 2026-09-26
Status: Design approved in chat; written spec awaiting review

## Purpose and scope

Build a standalone service for a Linux server running Docker. A caller submits a public Auto24 passenger-car listing URL. The service queues a browser extraction and returns the listing as JSON when complete. About 100 URLs per day are expected. Every submission, including a repeated URL, creates a new permanent snapshot so callers can judge freshness and compare changes.

The service extracts listing information only. It does not produce a buying verdict, contact sellers, reveal phone numbers, solve CAPTCHAs, log in to Auto24, or download photos. It is independent of the broader used-car analysis application described elsewhere in this repository.

## Deployment

Docker Compose runs three containers on a private network:

1. **API:** A Python HTTP server exposes the public job endpoints, validates API keys and URLs, and calls the storage service over the private network.
2. **Worker:** A Python process uses Camoufox to load pages, parses their rendered content, claims jobs from storage, and writes completed snapshots or errors back to storage.
3. **Storage:** A single-process internal HTTP service owns the open-source Turso Database engine and its persistent database file. It owns both the job queue and snapshot history. Its port is not published to the host.

The storage container is the only process that opens the Turso database file. Database calls within that process are serialized; no other container mounts or opens the file. This respects the current Turso Database manual's in-process and multi-process limitations. A named Docker volume holds the database independently of all container images. Rebuilding application or storage images does not remove the volume. Removing or losing the volume does remove the data, so deployment documentation includes a backup and restore procedure. No Turso Cloud, libSQL `sqld`, or Redis service is used.

The API and worker share one application image with different startup commands. The storage image may use the same codebase but has its own startup command and persistent volume. Only the API port is published; operators may place a reverse proxy and TLS in front of it.

## Public API

All public endpoints except health checks require an API key in a request header. Responses use JSON. Timestamps are ISO 8601 UTC strings.

### Submit

`POST /v1/jobs` accepts:

```json
{"url":"https://www.auto24.ee/soidukid/1234567"}
```

On success it stores a new queued job and returns HTTP 202:

```json
{
  "job_id": "job_01k6abc123",
  "status": "queued",
  "submitted_at": "2026-09-26T14:28:00Z",
  "status_url": "/v1/jobs/job_01k6abc123"
}
```

Every submission creates a new job, even when the URL has been submitted before. The service accepts HTTPS listing URLs with a numeric `/soidukid/{id}` path on `auto24.ee` and its recognized language or `www` subdomains, then uses the canonical `www.auto24.ee` URL for extraction. It rejects other hosts, schemes, and URL shapes. It checks main-frame redirects before browser navigation continues, preventing access to other hosts or private network addresses.

### Read job

`GET /v1/jobs/{job_id}` returns one of `queued`, `running`, `completed`, or `failed`.

A completed response is HTTP 200 and has this shape. Values below are illustrative, not a live extraction:

```json
{
  "job_id": "job_01k6abc123",
  "status": "completed",
  "submitted_at": "2026-09-26T14:28:00Z",
  "parsed_at": "2026-09-26T14:28:18Z",
  "listing": {
    "source_url": "https://www.auto24.ee/soidukid/1234567",
    "listing_id": "1234567",
    "title": "Skoda Enyaq 195kW",
    "make": "Skoda",
    "model": "Enyaq",
    "first_registration": "2022-03",
    "year": 2022,
    "year_source": "first_registration",
    "price": {"amount": 41500, "currency": "EUR"},
    "mileage_km": 46800,
    "body_type": "universaal",
    "fuel": "elekter",
    "power_kw": 195,
    "gearbox": "automaat",
    "drivetrain": "nelikvedu",
    "colour": "must",
    "seller_description": "Seller-provided description as shown on the listing.",
    "seller": {"name": "Example Seller", "type": "private", "location": "Eesti"},
    "equipment": {"Turva- ja ohutusvarustus": ["ABS pidurid"]},
    "technical_specs": {"istekohti": "5", "uste arv": "5"},
    "other_fields": {"Ülevaatus kuni": "03.2028"},
    "photo_urls": ["https://images.example.test/car-1.jpg"]
  },
  "warnings": []
}
```

For `queued` and `running`, `listing` and `parsed_at` are null. For `failed`, they are null and `error` contains a stable machine-readable code and short message. An unknown job ID returns HTTP 404. Invalid URL input returns HTTP 400 and a missing or invalid API key returns HTTP 401.

## Extraction contract

The worker uses Camoufox's Python Playwright interface to load one public listing page per job. It captures listing-specific visible content from structured page metadata and the rendered DOM. The parser separates specification rows, equipment groups, technical specifications, seller description, seller details, and photo URLs. It retains Auto24's original page labels for fields that do not map to stable normalized keys. Descriptions remain in their original language and preserve meaningful paragraph breaks, with recognized phone numbers redacted.

Core fields include listing ID and title, make and model, first registration, price and currency, mileage, body type, fuel, power, gearbox, drivetrain, and colour. A year derived from first registration is explicitly marked with `year_source: "first_registration"`; it is not asserted to be a separate model year. The response also includes listed equipment, technical data, visible seller name/type/location, and ordered photo URLs. VIN or registration values, if included, are only what the public listing already displays; the worker does not use reveal controls. Phone numbers are excluded from every output path, including `other_fields`; recognized phone numbers in seller prose are redacted while the rest of the prose remains intact.

Missing scalar fields are null; missing collections are empty. Warnings identify partial or uncertain extraction without fabricating values. Financing calculators, adverts, related listings, and other site chrome are excluded. Photos are URL references only.

The first implementation supports public passenger-car listings with a numeric `/soidukid/{id}` path on the recognized Auto24 hostnames above. Other URL shapes need explicit parser and URL-validation support before being accepted. If the page identifies a different vehicle category, the job fails with `unsupported_vehicle_type`.

## Queue, storage, and recovery

The storage service persists a `jobs` table and immutable completed snapshot data in Turso. A job records ID, submitted URL, state, submission/start/completion times, attempt count, lease deadline, error code/message, and result JSON. Completed jobs and snapshots have no automatic expiry. `parsed_at` is set only after successful extraction and is the UTC time the result was committed.

The worker asks the storage service to claim one queued job. The storage service makes the claim and lease update atomically, so one job cannot be claimed twice at once. The worker processes one job at a time initially. A bounded page timeout prevents indefinite browser use. If a worker stops while a job is running, its lease expires and the storage service makes it claimable again. Transient browser or network failures receive at most two retries with delay; permanent errors become `failed` immediately. Completion is idempotent by job ID and attempt/lease identity, so a late worker cannot overwrite a newer result. Restarting any container leaves queued jobs and saved results intact.

The API reads job state and snapshots through the storage service. Internal storage endpoints are bound only to the Compose network and accept a shared internal credential. The database volume is backed up using a documented consistent procedure, with restore tested before delivery. Disk use should be monitored because history is retained without expiry.

## Error behavior

Stable error codes distinguish `listing_gone`, `access_blocked`, `unsupported_vehicle_type`, `parse_failed`, and `temporary_failure`. A page missing essential identity fields fails with `parse_failed`; optional missing fields produce warnings. Auto24 changes or blocks can still prevent extraction. No CAPTCHA-solving or login flow is attempted. The API does not claim a successful parse when only a challenge or unrelated page was loaded.

## Testing and acceptance

Parser tests use saved, redacted Auto24 passenger-car pages covering different fuels, sellers, equipment, missing optional fields, and changed labels. API tests cover authentication, URL allowlisting and redirects, queued/running/completed/failed responses, repeated URLs, and UTC `parsed_at`. Queue tests cover one-at-a-time claims, lease expiry, bounded retries, idempotent completion, and container restart recovery. A manual end-to-end run submits a current public listing, polls to completion, checks extracted fields against the page, restarts the application containers, and confirms the saved result remains available. A backup/restore check confirms storage volume recovery.

The design is complete when a caller can submit any supported public Auto24 passenger-car listing, retrieve an accurate JSON snapshot through the polling API, see when it was parsed, and retrieve that snapshot indefinitely while the database and backups are retained. Implementation completion additionally requires the repository's requested clean subagent review and pull request.

## References

- Camoufox features and Python usage: <https://camoufox.com/features/>, <https://camoufox.com/python/usage/>
- Turso introduction and engine manual: <https://docs.turso.tech/introduction>, <https://github.com/tursodatabase/turso/blob/main/docs/manual.md>
- Example Auto24 passenger-car listing used to shape the parser: <https://www.auto24.ee/soidukid/4344096>
