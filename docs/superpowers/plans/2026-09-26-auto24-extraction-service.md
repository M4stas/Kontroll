# Auto24 Extraction Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Docker-hosted API that queues Auto24 passenger-car URLs and permanently stores timestamped JSON extracts.

**Architecture:** Public API and Camoufox worker communicate with a private storage HTTP service. The storage process alone opens an embedded open-source Turso database on a named Docker volume; a `jobs` table acts as the durable queue. One worker handles jobs sequentially at first.

**Tech Stack:** Python 3.12, FastAPI, Uvicorn, `pyturso`, Camoufox Python API, HTTPX, Beautiful Soup, Pytest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-26-auto24-extraction-service-design.md`

## Global Constraints

- Standalone service for a Linux Docker host, about 100 submissions per day.
- Public passenger-car listings only; no login, CAPTCHA solving, hidden-contact interaction, or photo download.
- New job and immutable snapshot on every submission, including repeated URLs.
- Completed records never expire automatically; `parsed_at` is ISO 8601 UTC.
- Open-source Turso Database runs embedded inside a separate storage container; only that process opens its database file.
- No Turso Cloud, libSQL `sqld`, or Redis.
- Public API requires an API key; storage API is private and requires an internal key.
- Final delivery requires task-relevant tests, a clean self-review in a subagent, a manual live listing check, and a pull request.

## Checkpoints and demos

Complete these in order. At each checkpoint, run the stated commands with a current public passenger-car URL, save the command and representative output in the progress notes, and show the result to the user before starting the next checkpoint. Invite feedback on that demo; continue with the next checkpoint unless the user redirects. A checkpoint is complete only when its acceptance checks pass; an access block is reported as an observed failure, not a successful extraction. Each checkpoint is a usable vertical slice, and the small numbered tasks below are the implementation units.

| Checkpoint | Tasks | Runnable result and demonstration | Acceptance evidence |
|---|---|---|---|
| 1. One-link scraper | 1–3 | `docker run --rm auto24-service python -m auto24_service.scrape_once https://www.auto24.ee/soidukid/4344096` prints one JSON listing, like the PoC. Show key fields, seller prose, photo URLs, and `parsed_at`. | Parser and browser tests pass; one current live listing produces valid JSON; invalid/non-car pages produce typed errors. |
| 2. Durable queue | 4–6 | Run storage on localhost, submit two URLs to its private endpoint, run the worker once per job, and fetch both stored results. Show queued and completed states, unique IDs for repeated URLs, and results surviving storage restart; show running state through the state-transition test. | Store, storage API/client, and worker tests pass; actual Turso file reopens with the same snapshots; lease expiry and retry tests pass. |
| 3. Public API | 7 | Start public API beside storage and worker. Show `POST /v1/jobs` returning 202 and `GET /v1/jobs/{id}` returning the completed listing JSON, plus invalid-key and invalid-URL responses. | Public API tests pass and a real local-process submit/poll round trip works. |
| 4. Docker service | 8 | Start `api`, `worker`, and `storage` with Compose. Show a live submit/poll, restart API and worker, then restore a storage backup and read the same result and `parsed_at`. | Compose health checks, end-to-end run, persistence and restore check, clean subagent review, and PR. |

The example URL is illustrative; use a currently active listing for live demos. Checkpoint 1 uses the same image that Checkpoint 4 later runs under Compose. Checkpoint 2's private endpoint binds only to localhost for the demo and is not part of the public interface. The user can inspect the saved JSON and test output at each checkpoint. Keep the service scope unchanged; no extra dashboard or UI is required.

## Estimates and overrun reporting

These are planning ranges for **elapsed time while agents are actively working**, including coding, test runs, Docker builds, debugging, review, and the checkpoint demo. Concurrent agent work is counted once, not summed as agent-hours. They exclude pauses awaiting user input. The 15-minute PoC is the baseline for the first checkpoint; packaging, tests, and a reusable parser/browser boundary add some time. LOC means new nonblank lines in Python source and tests plus `Dockerfile`, `compose.yaml`, `pyproject.toml`, and `.env.example`; fixtures, generated files, lockfiles, README, and progress notes are excluded. Count incremental lines added by each task, so the checkpoint rows are sums of their tasks.

| Task | Deliverable | Active time | Added LOC |
|---|---|---:|---:|
| 1 | Package, URL rules, JSON contract | 15–30 min | 150–250 |
| 2 | Listing parser and fixtures | 30–60 min | 220–350 |
| 3 | Runnable Camoufox script and image | 30–60 min | 200–330 |
| **Checkpoint 1** | **Show one-link JSON extraction** | **1 h 15 min–2 h 30 min** | **570–930** |
| 4 | Turso job store and leases | 60–120 min | 250–420 |
| 5 | Private storage API and client | 30–60 min | 220–360 |
| 6 | Queue worker and persistence demo | 30–60 min | 180–300 |
| **Checkpoint 2** | **Show durable queue** | **2–4 h** | **650–1,080** |
| 7 | Public submit/poll API | 30–60 min | 130–220 |
| **Checkpoint 3** | **Show public API** | **30–60 min** | **130–220** |
| 8 | Compose, docs, backup proof, final review, PR | 90–180 min | 160–280 |
| **Checkpoint 4** | **Show Docker deployment** | **1 h 30 min–3 h** | **160–280** |
| **Total remaining implementation** | **Tasks 1–8** | **5 h 15 min–10 h 30 min** | **1,510–2,510** |

Record start/end times and actual added LOC for every task in `docs/superpowers/checkpoints/auto24-extraction-progress.md`. At each checkpoint report estimated versus actual time and LOC to the user with the demo. Give an early progress notice when a checkpoint has used 80% of its upper time estimate and is not nearly done. **Notify the user as soon as active time exceeds the upper estimate or added LOC exceeds the upper estimate** for any task or checkpoint; do not wait until the next demo. State the cause, current totals, revised estimate, and whether the extra code is necessary or can be removed. Continue the authorized work while keeping the user informed; an overrun is a signal to reassess scope, not a reason to silently stop.

## Development agents and models

- Break the tasks below into small, independently reviewable slices when that makes the work suitable for GPT-6 Luna at max reasoning. Use Luna max for most implementation and focused tests.
- Use GPT-6 Sol at medium reasoning for integration work or debugging that needs broader context. Raise Sol above medium only if the problem remains unsolved at medium.
- Use a separate review subagent after implementation. Match the reviewer to the change: Luna max for narrow changes, Sol medium for integration changes, and the most capable available model for the final whole-branch review, as required by the subagent-driven-development workflow.
- Keep one implementer editing at a time to avoid shared-file conflicts. The production service itself makes no model calls.

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
| `src/auto24_service/scrape_once.py` | Standalone one-link JSON CLI |
| `src/auto24_service/worker.py` | Queue loop, retries, and completion |
| `Dockerfile`, `compose.yaml`, `.env.example` | Images, private network, volume, configuration |
| `docs/superpowers/checkpoints/auto24-extraction-progress.md` | Dated demo commands, representative JSON, and acceptance results |
| `tests/fixtures/` | Synthetic representative Auto24 HTML |
| `tests/` | Unit, contract, integration, and live smoke tests |
| `README.md` | Run, call, backup, restore, and limitations |
| `poc/auto24-camoufox/` | Throwaway feasibility probe and observed live results; informs parser and browser work, not production code |

### Task 0: Camoufox feasibility spike (completed before service work)

**Files:** `poc/auto24-camoufox/Dockerfile`, `poc/auto24-camoufox/scrape.py`, `poc/auto24-camoufox/README.md`, `poc/auto24-camoufox/EXPERIMENT_REPORT.md`.

**Interfaces:** CLI accepts one public Auto24 passenger-car URL and prints listing JSON on stdout or a JSON error on stderr. This is throwaway probe code; Tasks 2 and 3 replace its parser and capture logic with tested service modules.

- [x] **Step 1: Build a minimal Linux Docker image with Camoufox and Beautiful Soup.**
- [x] **Step 2: Implement a one-URL CLI with title, first registration/year, mileage, price, displayed fields, equipment, technical data, seller prose/name, listing notes, photo URLs, and UTC `parsed_at`.**
- [x] **Step 3: Run against four active public listings and one inactive listing.** Four returned HTTP 200 with listing-specific JSON; the inactive listing produced an explicit error. Exact URLs and captured values are in `EXPERIMENT_REPORT.md`.
- [x] **Step 4: Independently rerun the local Docker image against `https://www.auto24.ee/soidukid/4344096`.** It exited 0 and returned 2022 registration year, 46,800 km, €41,500, seller description, 7 equipment groups, 5 technical groups, and 19 photo URLs.
- [ ] **Step 5: Before relying on this in production, repeat the CLI from the intended Linux server/IP.** The local Docker result does not establish access from that IP or reliability at 100 requests/day.

**Spike conclusion:** Camoufox extraction is feasible in the tested local Docker environment. The PoC is not the service, and it is not a reliability guarantee.

### Task 1: Package, URL rules, and response contract

**Files:** Create `pyproject.toml`, `src/auto24_service/__init__.py`, `src/auto24_service/contracts.py`, `src/auto24_service/urls.py`, `tests/test_urls.py`, `tests/test_contracts.py`, `docs/superpowers/checkpoints/auto24-extraction-progress.md`.

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
- [ ] **Step 5: Record Task 1 actual time and added LOC in the progress notes, then commit:** `git add pyproject.toml src tests/test_urls.py tests/test_contracts.py docs/superpowers/checkpoints/auto24-extraction-progress.md && git commit -m "feat: define listing API contract"`.

### Task 2: Listing parser

**Files:** Create `src/auto24_service/parser.py`, `tests/fixtures/auto24-passenger-car.html`, `tests/fixtures/auto24-partial-car.html`, `tests/test_parser.py`.

**Interfaces:** `parse_listing(html: str, canonical_url: str) -> tuple[ListingResult, list[str]]`; `ParseError(code: str)` for `parse_failed` and `unsupported_vehicle_type`. The parser does not request network resources. Preserve visible labels in `other_fields`, equipment sections, and technical specs.

- [ ] **Step 1: Create synthetic HTML fixtures** based on the layouts observed on two public passenger-car pages. Include title, specification rows, equipment, technical data, seller prose, image URLs, and a partial page without optional fields. Write failing tests for first registration/year, price, mileage, seller prose preserved as written, ordered photo URLs, equipment groups, partial warnings, and rejection of a non-car `Liik` value.

```python
listing, warnings = parse_listing(fixture_html, "https://www.auto24.ee/soidukid/4344096")
assert listing.year == 2022
assert listing.year_source == "first_registration"
assert listing.mileage_km == 46800
assert listing.seller_description == "Example seller description."
assert listing.photo_urls
```

- [ ] **Step 2: Run `pytest tests/test_parser.py -q`; expect failures.**
- [ ] **Step 3: Implement deterministic extraction** with Beautiful Soup. Parse JSON-LD when present, then rendered headings and label/value rows. Normalize whitespace and numeric separators; keep paragraph boundaries in description; collect only listing-gallery images in DOM order. Use named page sections to avoid financing widgets and related listings. Preserve seller-written prose and never extract reveal controls. Put unmapped listing rows in `other_fields`.

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

### Task 3: One-link Camoufox scraper

**Files:** Create `src/auto24_service/browser.py`, `src/auto24_service/scrape_once.py`, `tests/test_browser.py`, `tests/test_scrape_once.py`, `Dockerfile`; update `docs/superpowers/checkpoints/auto24-extraction-progress.md`.

**Interfaces:** `capture_html(url: str) -> str` opens a fresh Camoufox session, checks main-frame navigation URLs, and returns rendered HTML. `python -m auto24_service.scrape_once URL` validates the URL, captures and parses it, and prints one listing JSON object with a UTC `parsed_at` on stdout. It exits nonzero with a JSON error on stderr for invalid, missing, blocked, or unsupported pages. This script is the first reusable vertical slice; Task 6 calls the same capture and parser functions.

- [ ] **Step 1: Write failing tests** with a fake browser and parser. Assert a valid URL prints parsed JSON with `parsed_at`, an invalid URL exits nonzero, a main-frame redirect to an unrelated host is blocked, a 404 or gone page becomes `listing_gone`, and a challenge page becomes `access_blocked`.

```python
result = scrape_once("https://www.auto24.ee/soidukid/4344096", capture=fake_capture)
assert result["listing_id"] == "4344096"
assert result["parsed_at"].endswith("Z")
```

- [ ] **Step 2: Run `pytest tests/test_browser.py tests/test_scrape_once.py -q`; expect failures.**
- [ ] **Step 3: Implement Camoufox capture** using its Python Playwright API. Limit a navigation to 45 seconds; use `page.route` to abort main-frame requests outside the canonical Auto24 host and block private or unrelated subresource URLs. Inspect the final URL, page status, and page body before parsing. Use error codes `listing_gone`, `access_blocked`, `unsupported_vehicle_type`, `parse_failed`, and `temporary_failure`. Do not interact with hidden-contact or CAPTCHA controls.

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

- [ ] **Step 4: Add the standalone CLI and initial Docker image.** The CLI calls `canonical_listing_url`, `capture_html`, and `parse_listing`, adds `parsed_at` after a successful parse, and serializes the listing as JSON. Reuse the PoC's proven Camoufox installation in the image; Task 8 adds Compose to this image.

```python
url = canonical_listing_url(raw_url)
html = capture_html(url)
listing, warnings = parse_listing(html, url)
return {**listing.model_dump(mode="json"), "parsed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "warnings": warnings}
```

- [ ] **Step 5: Run parser, browser, and CLI tests; build the image and run the CLI on one current public listing.** Save the exact command, a representative JSON result with title, mileage, year, seller description, photo URLs, and `parsed_at`, and test output in the progress notes for Checkpoint 1. If access is blocked, report the typed error and do not call the live demo complete.
- [ ] **Step 6: Commit:** `git add Dockerfile src/auto24_service/browser.py src/auto24_service/scrape_once.py tests/test_browser.py tests/test_scrape_once.py docs/superpowers/checkpoints/auto24-extraction-progress.md && git commit -m "feat: add runnable Auto24 JSON scraper"`.

### Task 4: Turso job store and durable state transitions

**Files:** Create `src/auto24_service/store.py`, `tests/test_store.py`.

**Interfaces:** Produce `JobStore(db_path: str, now: Callable[[], datetime])` with `create(url) -> JobRecord`, `get(job_id) -> JobRecord | None`, `claim() -> ClaimedJob | None`, `complete(job_id, lease_token, listing, warnings) -> bool`, and `fail(job_id, lease_token, code, message, transient) -> bool`. `JobRecord` and `ClaimedJob` are Pydantic models in this module. `complete` sets UTC `parsed_at` in the stored job record. All methods execute in the single storage process. The result is stored as JSON text; no result deletion path exists.

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

### Task 5: Private storage service

**Files:** Create `src/auto24_service/storage_api.py`, `src/auto24_service/storage_client.py`, `tests/test_storage_api.py`, `tests/test_storage_client.py`.

**Interfaces:** `create_storage_app(store: JobStore, internal_key: str) -> FastAPI`. Private routes: `POST /internal/jobs`, `GET /internal/jobs/{id}`, `POST /internal/jobs/claim`, `POST /internal/jobs/{id}/complete`, `POST /internal/jobs/{id}/fail`, and `GET /health`. Claim returns 204 when empty. Mutation routes require `X-Internal-Key`. `get` returns the stored public job representation to the API. Synchronous `StorageClient(base_url, internal_key)` provides `create(url)`, `get(job_id)`, `claim()`, `complete(job_id, lease_token, listing, warnings)`, and `fail(job_id, lease_token, code, message, transient)` methods mapping to these routes.

- [ ] **Step 1: Write failing ASGI and client tests** using `httpx.AsyncClient(transport=ASGITransport(app=app))` and a mocked HTTPX transport. Assert rejected missing key, create/claim/complete/get flow, 204 on an empty queue, and client propagation of job IDs, lease tokens, timeouts, and storage-unavailable errors.

```python
response = await client.post("/internal/jobs", headers={"X-Internal-Key": "secret"}, json={"url": "https://www.auto24.ee/soidukid/1"})
assert response.status_code == 201
claim = await client.post("/internal/jobs/claim", headers={"X-Internal-Key": "secret"})
assert claim.json()["job_id"] == response.json()["job_id"]
```

- [ ] **Step 2: Run `pytest tests/test_storage_api.py tests/test_storage_client.py -q`; expect failures.**
- [ ] **Step 3: Implement thin route handlers and HTTPX client** that call `JobStore` only in the storage process. Use async route functions with synchronous, short DB operations on the one event-loop thread; configure Uvicorn with one worker. Use `secrets.compare_digest` for the internal key. Export a runnable app from a lifespan factory that opens `TURSO_DB_PATH` (default `/data/auto24.db`) and closes it on shutdown. The storage server must bind to localhost for the Checkpoint 2 demo.

```python
@app.post("/internal/jobs/claim")
async def claim(x_internal_key: str = Header(default="")):
    require_internal_key(x_internal_key)
    job = store.claim()
    return Response(status_code=204) if job is None else job.model_dump(mode="json")
```

- [ ] **Step 4: Run storage API, client, and store tests; expect green.**
- [ ] **Step 5: Commit:** `git add src/auto24_service/storage_api.py src/auto24_service/storage_client.py tests/test_storage_api.py tests/test_storage_client.py && git commit -m "feat: expose private Turso job service"`.

### Task 6: Queue worker and durable queue demo

**Files:** Create `src/auto24_service/worker.py`, `tests/test_worker.py`; create or update `docs/superpowers/checkpoints/auto24-extraction-progress.md`.

**Interfaces:** `run_once(client: StorageClient, capture_html, parse_listing) -> bool` claims one job and commits success or a classified failure with the lease token. `run_forever` repeats with a two-second idle delay. `python -m auto24_service.worker --once` processes one eligible job using `STORAGE_URL` and `INTERNAL_API_KEY` and exits. The worker reuses Tasks 2 and 3; it does not duplicate parsing or browser logic.

- [ ] **Step 1: Write failing worker tests** with a fake storage client and fake capture function. Assert one claim completes once with listing JSON, empty queue returns false, a browser timeout is retryable, parse failure is terminal, and the completion request carries the lease token. The storage completion test verifies that the stored result gains UTC `parsed_at`.

```python
assert run_once(fake_client, lambda url: passenger_html, parse_listing) is True
assert fake_client.completed[0]["listing"]["listing_id"] == "4344096"
assert fake_client.completed[0]["lease_token"] == claim.lease_token
```

- [ ] **Step 2: Run `pytest tests/test_worker.py -q`; expect failures.**
- [ ] **Step 3: Implement the one-job path and loop.** Claim one job, call `capture_html` and `parse_listing`, store the JSON snapshot and warnings, and map capture/parser exceptions to the stable error codes. Use the lease token for every completion/failure. The browser context closes when capture exits. Log job IDs and state changes, not listing content.

```python
claim = client.claim()
if claim is None:
    return False
html = capture_html(claim.source_url)
listing, warnings = parse_listing(html, claim.source_url)
client.complete(claim.job_id, claim.lease_token, listing.model_dump(mode="json"), warnings)
return True
```

- [ ] **Step 4: Run store, storage API/client, and worker tests; expect green.**
- [ ] **Step 5: Demonstrate Checkpoint 2 with a temporary Turso file.** Start the storage app on `127.0.0.1:8001` with `TURSO_DB_PATH` set to a temporary file and `INTERNAL_API_KEY` set. Submit two current listing URLs through `POST /internal/jobs`, show each queued record, run `python -m auto24_service.worker --once` twice, and fetch both results through `GET /internal/jobs/{id}`. Submit the same URL twice and confirm distinct IDs. Restart storage against the same file and fetch an unchanged completed result with the same `parsed_at`. Record commands, IDs, representative JSON, and test output in the progress notes; redact the key.
- [ ] **Step 6: Commit:** `git add src/auto24_service/worker.py tests/test_worker.py docs/superpowers/checkpoints/auto24-extraction-progress.md && git commit -m "feat: process durable Auto24 queue"`.

### Task 7: Public submit and polling API

**Files:** Create `src/auto24_service/public_api.py`, `tests/test_public_api.py`; update `docs/superpowers/checkpoints/auto24-extraction-progress.md`.

**Interfaces:** `create_public_app(client: StorageClient, api_key: str) -> FastAPI` exposes `POST /v1/jobs`, `GET /v1/jobs/{id}`, and `GET /health`. POST canonicalizes the URL and returns 202. Polling returns stored status and data, 404 for unknown jobs. The HTTP client was implemented in Task 5.

- [ ] **Step 1: Write failing route tests** with a fake `StorageClient`: bad API key returns 401, bad URL returns 400 without calling storage, valid URL returns 202 and a status URL, unknown ID returns 404, completed result retains `parsed_at`.

```python
response = await client.post("/v1/jobs", headers={"X-API-Key": "secret"}, json={"url": "https://auto24.ee/soidukid/1"})
assert response.status_code == 202
assert response.json()["status_url"].startswith("/v1/jobs/")
```

- [ ] **Step 2: Run `pytest tests/test_public_api.py -q`; expect failures.**
- [ ] **Step 3: Implement public routes.** Use header `X-API-Key`, `secrets.compare_digest`, and a 503 error when the Task 5 client cannot reach storage. The API never opens the Turso file.

```python
@app.post("/v1/jobs", status_code=202)
def submit(body: SubmitBody, x_api_key: str = Header(default="")):
    require_api_key(x_api_key)
    url = canonical_listing_url(body.url)
    job = storage.create(url)
    return {**job, "status_url": f"/v1/jobs/{job['job_id']}"}
```

- [ ] **Step 4: Run public, storage, URL, and contract tests; expect green.** Start storage, API, and worker as local processes. Submit a current listing to `POST /v1/jobs`, poll `GET /v1/jobs/{id}` to completion, and show the response and invalid-key/invalid-URL cases. Record the commands and representative JSON in the progress notes for Checkpoint 3.
- [ ] **Step 5: Commit:** `git add src/auto24_service/public_api.py tests/test_public_api.py docs/superpowers/checkpoints/auto24-extraction-progress.md && git commit -m "feat: add queued extraction API"`.

### Task 8: Docker deployment, backup, and end-to-end proof

**Files:** Modify `Dockerfile`; create `compose.yaml`, `.env.example`, `tests/test_compose_contract.py`; update `README.md`, `docs/superpowers/checkpoints/auto24-extraction-progress.md`.

**Interfaces:** Compose services `api`, `worker`, `storage`; named volume `turso_data` mounted only by `storage`. Only `api` publishes a host port. Environment variables: `PUBLIC_API_KEY`, `INTERNAL_API_KEY`, `STORAGE_URL`, and `TURSO_DB_PATH`. Health checks gate startup.

- [ ] **Step 1: Write failing deployment contract tests** that parse `compose.yaml` and assert three services, only API published, storage volume present, and no Turso Cloud or Redis settings.

```python
compose = yaml.safe_load(Path("compose.yaml").read_text())
assert set(compose["services"]) == {"api", "worker", "storage"}
assert "ports" not in compose["services"]["storage"]
assert "turso_data" in compose["volumes"]
```

- [ ] **Step 2: Run `pytest tests/test_compose_contract.py -q`; expect missing-file failure.**
- [ ] **Step 3: Extend the Checkpoint 1 image and create Compose config.** Pin package and browser versions, retaining the proven Camoufox browser installation and required Firefox OS libraries. Start storage with one Uvicorn process and no reload mode. Set restart policies and health checks. Pass secrets through environment or Docker secrets; do not commit secret values. Mount `turso_data` only on storage.

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
- [ ] **Step 5: Run `docker compose config`, unit/ASGI tests, and `docker compose up --build`; expect all health checks green.** Submit a current public passenger-car URL, poll to completion, compare title/mileage/price/description/photos against the page, then restart API and worker and verify the job still returns the same `parsed_at`. Restore a backup into a fresh volume and verify the same job exists. Record commands, output, and backup/restore proof in the progress notes for Checkpoint 4. If the live site blocks access, report the observed error and validate the full happy path against a local captured fixture without claiming live success.
- [ ] **Step 6: Ask a separate subagent for a diff review; fix findings and repeat relevant tests.** This follows repository `AGENTS.md`. Obtain a clean review before calling implementation complete.
- [ ] **Step 7: Commit deployment/docs:** `git add Dockerfile compose.yaml .env.example README.md tests/test_compose_contract.py docs/superpowers/checkpoints/auto24-extraction-progress.md && git commit -m "docs: deploy extraction service with Turso"`.
- [ ] **Step 8: Create a pull request and attach it to the current task.** Include test output, live/manual result, backup/restore proof, known access limits, and reviewer outcome in the PR body.

## Plan self-review

- All approved spec sections map to Tasks 1–8: URL and JSON contract, Turso queue and history, private/public API, parsing, Camoufox, failures, security, deployment, backups, tests, and PR.
- The storage container alone opens the Turso file; the API and worker use internal HTTP.
- Repeat submissions create separate rows and do not overwrite a previous `parsed_at`.
- If a current page cannot be accessed, the implementation reports a typed failure rather than fabricated listing data.
