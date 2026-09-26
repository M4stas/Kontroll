# Auto24 Extraction Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Docker-hosted API that queues Auto24 passenger-car URLs and permanently stores timestamped JSON extracts.

**Architecture:** Public API and Camoufox worker communicate with a private storage HTTP service. The storage process alone opens an embedded open-source Turso database on a named Docker volume; a `jobs` table acts as the durable queue. One worker handles jobs sequentially at first.

**Tech Stack:** Python 3.12, FastAPI, Uvicorn, `pyturso`, Camoufox Python API, HTTPX, Beautiful Soup, Pytest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-26-auto24-extraction-service-design.md`

## Global Constraints

- Standalone service for a Linux Docker host, about 100 submissions per day.
- Public passenger-car listings only; no login, CAPTCHA solving, phone-number reveal, or photo download.
- New job and immutable snapshot on every submission, including repeated URLs.
- Completed records never expire automatically; `parsed_at` is ISO 8601 UTC.
- Open-source Turso Database runs embedded inside a separate storage container; only that process opens its database file.
- No Turso Cloud, libSQL `sqld`, or Redis.
- Public API requires an API key; storage API is private and requires an internal key.
- Final delivery requires task-relevant tests, a clean self-review in a subagent, a manual live listing check, and a pull request.

## File map

| Path | Responsibility |
|---|---|
| `pyproject.toml` | Runtime and test dependencies, package metadata |
| `src/auto24_service/contracts.py` | Public JSON models and stable error codes |
| `src/auto24_service/urls.py` | Auto24 URL validation and canonicalization |
| `src/auto24_service/store.py` | Turso schema, claims, leases, snapshots |
| `src/auto24_service/storage_api.py` | Private HTTP facade for the Turso owner process |
| `src/auto24_service/storage_client.py` | HTTP client shared by public API and worker |
| `src/auto24_service/public_api.py` | Public submit and poll endpoints |
| `src/auto24_service/parser.py` | HTML to listing JSON conversion |
| `src/auto24_service/browser.py` | Camoufox navigation and page capture |
| `src/auto24_service/worker.py` | Queue loop, retries, and completion |
| `Dockerfile`, `compose.yaml`, `.env.example` | Images, private network, volume, configuration |
| `tests/fixtures/` | Redacted representative Auto24 HTML |
| `tests/` | Unit, contract, integration, and live smoke tests |
| `README.md` | Run, call, backup, restore, and limitations |

### Task 1: Package, URL rules, and response contract

**Files:** Create `pyproject.toml`, `src/auto24_service/__init__.py`, `src/auto24_service/contracts.py`, `src/auto24_service/urls.py`, `tests/test_urls.py`, `tests/test_contracts.py`.

**Interfaces:** Produce `canonical_listing_url(raw: str) -> str` raising `InvalidListingURL`; `JobResponse`, `ListingResult`, and `JobError` Pydantic models. `JobResponse` includes nullable `status_url` for the submit response. The public API and browser use the canonical URL. `year_source` is `first_registration` when `year` is derived from that field.

- [ ] **Step 1: Write failing URL and JSON contract tests.**

```python
def test_canonicalizes_known_host():
    assert canonical_listing_url("https://eng.auto24.ee/soidukid/4344096?foo=1") == "https://www.auto24.ee/soidukid/4344096"

@pytest.mark.parametrize("url", ["http://www.auto24.ee/soidukid/1", "https://evil.test/soidukid/1", "https://www.auto24.ee/soidukid/1/../../admin"])
def test_rejects_unsafe_urls(url):
    with pytest.raises(InvalidListingURL):
        canonical_listing_url(url)

def test_completed_job_has_utc_parse_time():
    response = JobResponse(job_id="j1", status="completed", submitted_at="2026-09-26T14:28:00Z", parsed_at="2026-09-26T14:28:18Z", listing=ListingResult(source_url="https://www.auto24.ee/soidukid/1", listing_id="1", title="Example"))
    assert response.model_dump(mode="json")["parsed_at"].endswith("Z")
```

- [ ] **Step 2: Run `pytest tests/test_urls.py tests/test_contracts.py -q`; expect import failures.**
- [ ] **Step 3: Add the package and minimal typed models.** Use `urllib.parse.urlsplit`, an exact hostname set (`auto24.ee`, `www.auto24.ee`, `eng.auto24.ee`, `rus.auto24.ee`), and `re.fullmatch(r"/soidukid/([0-9]+)/?", path)`. Reject credentials, ports, fragments, non-HTTPS, and malformed paths. Define `JobResponse` with `job_id`, `status`, `submitted_at`, nullable `parsed_at`, nullable `listing`, nullable `error`, and `warnings`. Define listing keys from the approved spec, with nullable scalars and empty collection defaults.

```python
match = re.fullmatch(r"/soidukid/([0-9]+)/?", parts.path)
if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS or parts.port is not None or parts.username or parts.fragment or not match:
    raise InvalidListingURL(raw)
return f"https://www.auto24.ee/soidukid/{match.group(1)}"
```

- [ ] **Step 4: Run the two test files; expect green.**
- [ ] **Step 5: Commit:** `git add pyproject.toml src tests/test_urls.py tests/test_contracts.py && git commit -m "feat: define listing API contract"`.

### Task 2: Turso job store and durable state transitions

**Files:** Create `src/auto24_service/store.py`, `tests/test_store.py`.

**Interfaces:** Produce `JobStore(db_path: str, now: Callable[[], datetime])` with `create(url) -> JobRecord`, `get(job_id) -> JobRecord | None`, `claim() -> ClaimedJob | None`, `complete(job_id, lease_token, listing, warnings) -> bool`, and `fail(job_id, lease_token, code, message, transient) -> bool`. `JobRecord` and `ClaimedJob` are Pydantic models in this module. All methods execute in the single storage process. The result is stored as JSON text; no result deletion path exists.

- [ ] **Step 1: Write failing store tests** for a fresh queued job, repeated URL producing two IDs, a single claim, an expired lease becoming claimable, stale lease completion being rejected, transient failure retry limit, and permanent results surviving a new `JobStore` instance.

```python
first = store.create("https://www.auto24.ee/soidukid/1")
second = store.create("https://www.auto24.ee/soidukid/1")
assert first.job_id != second.job_id
claim = store.claim()
assert claim.job_id == first.job_id
assert store.claim().job_id == second.job_id
assert store.complete(first.job_id, "wrong-token", {"title": "A"}, []) is False
```

- [ ] **Step 2: Run `pytest tests/test_store.py -q`; expect failures.**
- [ ] **Step 3: Create the Turso schema and transitions.** Keep connection access serialized in one process. Use explicit transactions for claim and completion. Store UTC times as text, with `lease_token` and `lease_until` checked on completion. Claim oldest eligible queued or expired-running job, increment `attempts`, and grant a two-minute lease. Retry transient failures at most twice after the first attempt, with bounded delays; mark the third failure terminal. Keep completed snapshots forever.

```sql
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  started_at TEXT,
  parsed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  retry_at TEXT,
  listing_json TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, retry_at, lease_until, submitted_at);
```

- [ ] **Step 4: Run `pytest tests/test_store.py -q`; expect green, including reopen persistence.**
- [ ] **Step 5: Commit:** `git add src/auto24_service/store.py tests/test_store.py && git commit -m "feat: persist extraction jobs in Turso"`.

### Task 3: Private storage service

**Files:** Create `src/auto24_service/storage_api.py`, `tests/test_storage_api.py`.

**Interfaces:** `create_storage_app(store: JobStore, internal_key: str) -> FastAPI`. Private routes: `POST /internal/jobs`, `GET /internal/jobs/{id}`, `POST /internal/jobs/claim`, `POST /internal/jobs/{id}/complete`, `POST /internal/jobs/{id}/fail`, and `GET /health`. Claim returns 204 when empty. Mutation routes require `X-Internal-Key`. `get` returns the stored public job representation to the API.

- [ ] **Step 1: Write failing ASGI tests** using `httpx.AsyncClient(transport=ASGITransport(app=app))`. Assert rejected missing key, create/claim/complete/get flow, and 204 on an empty queue.

```python
response = await client.post("/internal/jobs", headers={"X-Internal-Key": "secret"}, json={"url": "https://www.auto24.ee/soidukid/1"})
assert response.status_code == 201
claim = await client.post("/internal/jobs/claim", headers={"X-Internal-Key": "secret"})
assert claim.json()["job_id"] == response.json()["job_id"]
```

- [ ] **Step 2: Run `pytest tests/test_storage_api.py -q`; expect failures.**
- [ ] **Step 3: Implement thin route handlers** that call `JobStore` in the storage process. Use async route functions with synchronous, short DB operations on the one event-loop thread; configure Uvicorn with one worker. Use `secrets.compare_digest` for the internal key. Generate the actual app in a lifespan factory that opens `/data/auto24.db` and closes it on shutdown.

```python
@app.post("/internal/jobs/claim")
async def claim(x_internal_key: str = Header(default="")):
    require_internal_key(x_internal_key)
    job = store.claim()
    return Response(status_code=204) if job is None else job.model_dump(mode="json")
```

- [ ] **Step 4: Run storage API and store tests; expect green.**
- [ ] **Step 5: Commit:** `git add src/auto24_service/storage_api.py tests/test_storage_api.py && git commit -m "feat: expose private Turso job service"`.

### Task 4: Public submit and polling API

**Files:** Create `src/auto24_service/storage_client.py`, `src/auto24_service/public_api.py`, `tests/test_public_api.py`.

**Interfaces:** Synchronous `StorageClient(base_url, internal_key)` has `create(url)`, `get(job_id)`, `claim()`, `complete(job_id, lease_token, listing, warnings)`, and `fail(job_id, lease_token, code, message, transient)` methods that map directly to the private routes. `create_public_app(client, api_key) -> FastAPI` exposes `POST /v1/jobs`, `GET /v1/jobs/{id}`, and `GET /health`. POST canonicalizes the URL and returns 202. Polling returns stored status and data, 404 for unknown jobs.

- [ ] **Step 1: Write failing route tests** with a fake `StorageClient`: bad API key returns 401, bad URL returns 400 without calling storage, valid URL returns 202 and a status URL, unknown ID returns 404, completed result retains `parsed_at`.

```python
response = await client.post("/v1/jobs", headers={"X-API-Key": "secret"}, json={"url": "https://auto24.ee/soidukid/1"})
assert response.status_code == 202
assert response.json()["status_url"].startswith("/v1/jobs/")
```

- [ ] **Step 2: Run `pytest tests/test_public_api.py -q`; expect failures.**
- [ ] **Step 3: Implement the HTTPX client and public routes.** Use exact header keys `X-API-Key` and `X-Internal-Key`, `secrets.compare_digest`, a timeout on storage calls, and a 503 error when storage is unavailable. The API never opens the Turso file.

```python
@app.post("/v1/jobs", status_code=202)
def submit(body: SubmitBody, x_api_key: str = Header(default="")):
    require_api_key(x_api_key)
    url = canonical_listing_url(body.url)
    job = storage.create(url)
    return {**job, "status_url": f"/v1/jobs/{job['job_id']}"}
```

- [ ] **Step 4: Run public, storage, URL, and contract tests; expect green.**
- [ ] **Step 5: Commit:** `git add src/auto24_service/storage_client.py src/auto24_service/public_api.py tests/test_public_api.py && git commit -m "feat: add queued extraction API"`.

### Task 5: Listing parser

**Files:** Create `src/auto24_service/parser.py`, `tests/fixtures/auto24-passenger-car.html`, `tests/fixtures/auto24-partial-car.html`, `tests/test_parser.py`.

**Interfaces:** `parse_listing(html: str, canonical_url: str) -> tuple[ListingResult, list[str]]`; `ParseError(code: str)` for `parse_failed` and `unsupported_vehicle_type`. The parser does not request network resources. Preserve visible labels in `other_fields`, equipment sections, and technical specs.

- [ ] **Step 1: Save redacted HTML fixtures** from two public passenger-car pages. Remove personal contact details from fixtures. Include title, specification rows, equipment, technical data, seller prose, image URLs, and a partial page without optional fields. Write failing tests for first registration/year, price, mileage, original seller prose with contact numbers redacted, ordered photo URLs, equipment groups, partial warnings, and rejection of a non-car `Liik` value.

```python
listing, warnings = parse_listing(fixture_html, "https://www.auto24.ee/soidukid/4344096")
assert listing.year == 2022
assert listing.year_source == "first_registration"
assert listing.mileage_km == 46800
assert "phone" not in listing.model_dump_json().lower()
assert listing.photo_urls
```

- [ ] **Step 2: Run `pytest tests/test_parser.py -q`; expect failures.**
- [ ] **Step 3: Implement deterministic extraction** with Beautiful Soup. Parse JSON-LD when present, then rendered headings and label/value rows. Normalize whitespace and numeric separators; keep paragraph boundaries in description; collect only listing-gallery images in DOM order. Use named page sections to avoid financing widgets and related listings. Redact recognized phone-like strings from prose and never extract reveal controls. Put unmapped listing rows in `other_fields`, with no contact keys.

```python
def parse_listing(html: str, canonical_url: str) -> tuple[ListingResult, list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    heading = soup.select_one("h1")
    if heading is None or not heading.get_text(" ", strip=True):
        raise ParseError("parse_failed")
    listing_id = canonical_url.rsplit("/", 1)[-1]
    result = ListingResult(source_url=canonical_url, listing_id=listing_id, title=heading.get_text(" ", strip=True))
    return result, []
```

- [ ] **Step 4: Run `pytest tests/test_parser.py -q`; expect green.**
- [ ] **Step 5: Commit:** `git add src/auto24_service/parser.py tests/fixtures tests/test_parser.py && git commit -m "feat: parse Auto24 passenger-car listings"`.

### Task 6: Camoufox capture and queue worker

**Files:** Create `src/auto24_service/browser.py`, `src/auto24_service/worker.py`, `tests/test_browser.py`, `tests/test_worker.py`.

**Interfaces:** `capture_html(url: str) -> str` opens a fresh Camoufox session, checks main-frame navigation URLs, and returns rendered HTML. `run_once(client, capture_html, parse_listing) -> bool` claims one job and commits success or classified failure. `run_forever` repeats with a short idle delay. Only the worker accesses Auto24.

- [ ] **Step 1: Write failing tests** with a fake browser and fake storage client. Assert normal completion saves one JSON result, a main-frame redirect to an unrelated host is blocked before loading, a 404 or gone page becomes `listing_gone`, a challenge page becomes `access_blocked`, and a transient timeout is sent as retryable.

```python
assert run_once(fake_client, lambda url: passenger_html, parse_listing) is True
assert fake_client.completed[0]["listing"]["listing_id"] == "4344096"
assert fake_client.completed[0]["warnings"] == []
```

- [ ] **Step 2: Run `pytest tests/test_browser.py tests/test_worker.py -q`; expect failures.**
- [ ] **Step 3: Implement Camoufox capture** using its Python Playwright API. Limit a navigation to 45 seconds; use `page.route` to abort main-frame requests outside the canonical Auto24 host and block private or unrelated subresource URLs. Inspect the final URL, page status, and page body before parsing. Open and close a browser context for each job. Use worker error mapping: `listing_gone`, `access_blocked`, `unsupported_vehicle_type`, `parse_failed`, `temporary_failure`. Do not click phone-reveal or CAPTCHA controls.

```python
def guard_request(route):
    target = urlsplit(route.request.url)
    allowed = target.scheme == "https" and target.hostname in ALLOWED_ASSET_HOSTS
    return route.continue_() if allowed else route.abort()

with Camoufox(headless=True) as browser:
    page = browser.new_page()
    page.route("**/*", guard_request)
    response = page.goto(url, timeout=45_000, wait_until="domcontentloaded")
    if response is None:
        raise CaptureError("temporary_failure")
    if response.status in (404, 410):
        raise CaptureError("listing_gone")
    if page.url != url:
        raise CaptureError("access_blocked")
    return page.content()
```

- [ ] **Step 4: Implement the worker loop** with one claim at a time and a two-second idle poll. Pass the lease token to completion/failure calls. Ensure Camoufox is closed in `finally` and log job IDs rather than listing content.

```python
claim = client.claim()
if claim is None:
    return False
html = capture_html(claim.source_url)
listing, warnings = parse_listing(html, claim.source_url)
client.complete(claim.job_id, claim.lease_token, listing.model_dump(mode="json"), warnings)
return True
```

- [ ] **Step 5: Run all unit and ASGI tests; expect green.**
- [ ] **Step 6: Commit:** `git add src/auto24_service/browser.py src/auto24_service/worker.py tests/test_browser.py tests/test_worker.py && git commit -m "feat: run Camoufox extraction worker"`.

### Task 7: Docker deployment, backup, and end-to-end proof

**Files:** Create `Dockerfile`, `compose.yaml`, `.env.example`, `tests/test_compose_contract.py`; update `README.md`.

**Interfaces:** Compose services `api`, `worker`, `storage`; named volume `turso_data` mounted only by `storage`. Only `api` publishes a host port. Environment variables: `PUBLIC_API_KEY`, `INTERNAL_API_KEY`, `STORAGE_URL`, and `TURSO_DB_PATH`. Health checks gate startup.

- [ ] **Step 1: Write failing deployment contract tests** that parse `compose.yaml` and assert three services, only API published, storage volume present, and no Turso Cloud or Redis settings.

```python
compose = yaml.safe_load(Path("compose.yaml").read_text())
assert set(compose["services"]) == {"api", "worker", "storage"}
assert "ports" not in compose["services"]["storage"]
assert "turso_data" in compose["volumes"]
```

- [ ] **Step 2: Run `pytest tests/test_compose_contract.py -q`; expect missing-file failure.**
- [ ] **Step 3: Create image and Compose config.** Pin package and browser versions, install Camoufox browser during image build, and include required Firefox OS libraries. Start storage with one Uvicorn process and no reload mode. Set restart policies and health checks. Pass secrets through environment or Docker secrets; do not commit secret values. Mount `turso_data` only on storage.

```yaml
services:
  api:
    build: .
    ports: ["${API_BIND:-127.0.0.1:8000}:8000"]
  worker:
    build: .
  storage:
    build: .
    volumes: ["turso_data:/data"]
volumes:
  turso_data:
```

- [ ] **Step 4: Document exact `curl` submit/poll examples, error examples, configuration, and backup/restore commands.** For a consistent backup, stop the storage service, copy the complete data volume to a timestamped archive, then start storage; restore into a fresh named volume while storage is stopped. State that deleting the volume deletes history.
- [ ] **Step 5: Run `docker compose config`, unit/ASGI tests, and `docker compose up --build`; expect all health checks green.** Submit a current public passenger-car URL, poll to completion, compare title/mileage/price/description/photos against the page, then restart API and worker and verify the job still returns the same `parsed_at`. Restore a backup into a fresh volume and verify the same job exists. If the live site blocks access, report the observed error and validate the full happy path against a local captured fixture without claiming live success.
- [ ] **Step 6: Ask a separate subagent for a diff review; fix findings and repeat relevant tests.** This follows repository `AGENTS.md`. Obtain a clean review before calling implementation complete.
- [ ] **Step 7: Commit deployment/docs:** `git add Dockerfile compose.yaml .env.example README.md tests/test_compose_contract.py && git commit -m "docs: deploy extraction service with Turso"`.
- [ ] **Step 8: Create a pull request and attach it to the current task.** Include test output, live/manual result, backup/restore proof, known access limits, and reviewer outcome in the PR body.

## Plan self-review

- All approved spec sections map to Tasks 1–7: URL and JSON contract, Turso queue and history, private/public API, parsing, Camoufox, failures, security, deployment, backups, tests, and PR.
- The storage container alone opens the Turso file; the API and worker use internal HTTP.
- Repeat submissions create separate rows and do not overwrite a previous `parsed_at`.
- If a current page cannot be accessed, the implementation reports a typed failure rather than fabricated listing data.
