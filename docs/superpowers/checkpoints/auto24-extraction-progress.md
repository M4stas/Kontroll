# Auto24 extraction service checkpoints

## Task 1: Package, URL rules, and response contract

- Status: complete
- Start: 2026-09-26 23:30 UTC (approximate delegation time)
- End: 2026-09-26 23:40 UTC (commit completed at 23:40:23 UTC)
- Elapsed: about 10 minutes
- Added nonblank source, test, and configuration lines: 187
- RED: both requested test modules failed collection because `auto24_service` did not exist.
- GREEN: focused contract tests passed (13); full available suite passed (13).
- Environment: host Python lacked pytest and Pydantic and could not reach the package index. Docker worked with escalation; dependencies were installed in a disposable container.
- Commit: recorded in the Task 1 report.

### P2 review follow-up: enforce response invariants

- Status: complete
- Start: approximately 2026-09-26 23:44 UTC (first time captured after dispatch)
- End: approximately 2026-09-26 23:53 UTC, including the follow-up commit
- Elapsed: about 9 minutes; about 23 minutes across Task 1 and this follow-up
- Source, test, and configuration LOC: 249 nonblank lines total (up from 187; 62 net lines added). Documentation is excluded.
- RED: the contract suite had 13 expected invalid-state/year-source failures and 4 passing valid cases.
- GREEN: focused and full suites each passed 28 tests.
- `git diff --check` was clean. No unresolved implementation concerns.

### P2 review follow-up 2: reject errors on completed jobs

- Status: complete
- Start: approximately 2026-09-26 23:55 UTC
- End: approximately 2026-09-26 23:57 UTC, including the follow-up commit
- Elapsed: about 2 minutes; about 27 minutes across Task 1 and both review follow-ups
- Source, test, and configuration LOC: 259 nonblank lines total (up from 249; 10 net lines added). Documentation is excluded.
- RED: the new completed-with-error test failed because the model did not raise `ValidationError`.
- GREEN: focused and full suites each passed 29 tests.
- `git diff --check` was clean; no unresolved implementation concerns.

## Task 2: Listing parser

- Status: complete
- Start: 2026-09-26 23:59 UTC
- End: approximately 2026-09-27 00:16 UTC, including the commit
- Elapsed: approximately 17 minutes
- Added nonblank source, test, and configuration lines: 492 (parser 401, tests 90, dependency 1). Synthetic fixtures add 80 nonblank lines and are excluded from this count.
- RED: the initial focused run failed collection because `auto24_service.parser` did not exist. A later regression RED produced 3 expected failures for dropped `Liik` labels and JSON-LD-only photos.
- GREEN: focused parser suite passed 9 tests; full suite passed 38 tests.
- Environment: Docker `python:3.12-slim` with pytest, Pydantic, and Beautiful Soup installed; host Python lacked the required packages.
- `git diff --check` was clean. Self-review retained only listing-gallery photo URLs and preserved the validated `Liik` row in `other_fields`.
- Complexity note: parser is 401 nonblank lines because it supports JSON-LD fallback, rendered-row precedence, localized numeric normalization, and scoped extraction that excludes unrelated page sections. See Task 2 report for details.

### Task 2 review follow-up: identity, notes, multiple tables, and seller merge

- Status: complete
- Start: 2026-09-27 00:19 UTC
- End: approximately 2026-09-27 00:28 UTC, including the follow-up commit
- Elapsed: approximately 9 minutes
- Final added nonblank source, test, and configuration lines: 570 (parser 461, tests 108, dependency 1); fixture HTML is excluded.
- RED: after adding regression coverage, 4 focused tests failed for missing vehicle identity validation, dropped later-table/other-info fields, and lost metadata seller type. A separate JSON-LD `category: truck` RED caught the wrong error code (`parse_failed` instead of `unsupported_vehicle_type`).
- GREEN: focused parser suite passed 11 tests; full suite passed 40 tests.
- `git diff --check` was clean. The parser now requires positive car identity, gathers every listing main-data table, preserves labeled other-info notes, and merges seller fields while retaining metadata values.
- Size note: final source/test/config count is 20 lines above the provisional 550 upper bound; the added lines implement the four requested review fixes.

## Task 3: One-link Camoufox scraper

- Status: complete
- Start: 2026-09-27 00:29:35 UTC
- End: approximately 2026-09-27 01:11 UTC, including the final commit
- Elapsed: approximately 41 minutes
- Added nonblank source, test, and configuration lines: 395 (browser 111, CLI 56, Dockerfile 20, runtime dependency 1, new browser/CLI tests 167, parser fixes 6, parser regression tests 34). Documentation is excluded.
- RED: the first focused browser/CLI run failed collection because the two production modules did not exist. Live-driven parser regressions then failed as expected for the bookmark widget and seller phone reveal, HTTP 401 initially returned `temporary_failure`, and explicit `Mootor / võimsus: 195 kW` was not copied to `power_kw`.
- GREEN: the final full suite in the final image passed 60 tests (`60 passed in 0.78s`). The browser and CLI tests cover URL validation, redirect and subresource guards, 404/410 and rendered gone pages, access challenges, authentication/rate limits, parse errors, and UTC JSON output.
- Docker: `docker build -t auto24-extraction-service:task-3-final .` succeeded from `python:3.12-slim-bookworm`. Camoufox 152.0.4-beta.31 and its browser assets were fetched successfully (653.9 MB browser archive). The Dockerfile installs the runtime dependencies and browser before copying the source, so source edits reuse that cached browser layer.
- Exact live demo command: `docker run --rm auto24-extraction-service:task-3-final https://www.auto24.ee/soidukid/4344096`
- Demo result: exit code 0; parsed at `2026-09-27T01:04:13.818500Z`. The current public listing is a 2022 Skoda Enyaq with 46,800 km. The JSON returned title `Skoda Enyaq 195kW`, `year: 2022`, `mileage_km: 46800`, `power_kw: 195`, the seller's description, seven equipment groups, 16 technical specs, and 19 photo URLs. The final title excludes the nested bookmark count; seller location is null instead of the phone reveal label.
- Live JSON excerpt (wide lists shortened; the full run returned seven equipment groups and 19 photo URLs):

```json
{
  "source_url": "https://www.auto24.ee/soidukid/4344096",
  "listing_id": "4344096",
  "title": "Skoda Enyaq 195kW",
  "year": 2022,
  "mileage_km": 46800,
  "power_kw": 195,
  "seller_description": "Müüa väga heas korras Enyaq 80X, läbisõit ca 46 800 km (auto on igapäevases kasutuses, seega läbisõit muutub). Ilus nahksisu, head-up display, ruumikas salong ja suur pagasiruum.\n\nVäga hästi läbi mõeldud pereauto – tagaustel on integreeritud päikesevarjud ning peatugedest saab välja tõmmata küljetoed, mis hoiavad magama jäänud lapse pea sõidu ajal kenasti paigal.\n\nVäga hea sõiduomadustega, mõnus kiirendus, kaasa tuleb laadija mida saab tööstusvoolu pistikusse panna.\n\n80X sai omal ajal valitud just nelikveo ja talvise sõiduulatuse pärast. Isegi krõbeda Eesti külmaga saab Tallinnast Elvasse ühe laadimisega sõidetud ning jääb veel sõiduulatust üle. Meie jaoks ei pakkunud seda tol ajal näiteks vaadatud Audi e-tron ega Mercedes EQ400.\n\nVäga mugav, praktiline ja kindel pereauto Eesti oludesse.\n\nAutol on kehtiv garantii, kõik tehnilised vead tehakse garantii korras korda! Rohe Autos on käidud hoolduses, Eestis esimene omanik, toodud Tšehhist.",
  "equipment": {
    "Turva- ja ohutusvarustus": ["ABS pidurid", "automaatne paigalseismise funktsioon / mägistardi abi"]
  },
  "technical_specs": {
    "Kere / pikkus": "4699 mm",
    "Mootor / võimsus": "195 kW"
  },
  "photo_urls": [
    "https://img13.img-bcg.eu/h30/78fe0a/s1/206545262.jpg",
    "https://img13.img-bcg.eu/h30/2ab9a7/s1/206545270.jpg"
  ],
  "parsed_at": "2026-09-27T01:09:54.265983Z"
}
```

- Live inspection found no JSON-LD metadata or distinct visible make/model labels. The parser leaves `make` and `model` null instead of splitting the title. It also leaves seller location null because the page exposed only phone/email controls, and it never interacted with those controls.
- The task report is in `.superpowers/sdd/2026-09-26-auto24-extraction-service/task-3-report.md`.

### Task 3 review follow-up

- RED: the new test showed `assets.auto24.ee` was allowed by the suffix rule. A 503 challenge-body test also failed because the response status was classified before reading its content; the ordinary 503 case already returned `temporary_failure`.
- GREEN: the named subresource host allowlist now contains only `www.auto24.ee`. A 503 response body is checked for a known access challenge before generic HTTP errors map to `temporary_failure`. The focused tests passed 3 cases; the full suite passed 63 tests (`63 passed in 0.98s`).
- Rebuilt `auto24-extraction-service:task-3-final` and reran the no-mount command `docker run --rm auto24-extraction-service:task-3-final https://www.auto24.ee/soidukid/4344096`. It returned the expected 2022 listing, 46,800 km, 195 kW, seller description, seven equipment groups, 16 technical specs, 19 photo URLs, and UTC `parsed_at` `2026-09-27T01:17:40.666035Z`.
- Cumulative added nonblank source/test/config lines: 413, within the 430-line ceiling. Photos remain URL-extracted from the document; their CDN hosts are no longer fetched by the browser.

## Checkpoint 1: One-link scraper

- Status: accepted after independent spec/quality reviews of Tasks 1–3.
- Active elapsed time: approximately 1 h 51 min (2026-09-26 23:29 UTC to 2026-09-27 01:20 UTC), within the 1 h 15 min–2 h 30 min estimate.
- Added code/test/config LOC: 1,242 (Task 1: 259; Task 2: 570; Task 3: 413), above the original 930 upper estimate. Revised actual: 1,242. Most additional lines are the listing parser, regression tests, and review fixes; the user was notified during implementation and at checkpoint completion.
- Exact independent command: `docker run --rm auto24-extraction-service:task-3-final https://www.auto24.ee/soidukid/4344096 > /private/tmp/auto24-checkpoint1.json`.
- Independent result: exit code 0; `parsed_at` 2026-09-27T01:20:25.549672Z; title Skoda Enyaq 195kW; first registration 2022-03; €41,500; 46,800 km; 195 kW; 949 characters of seller description; 86 equipment items in 7 groups; 16 technical fields; 7 other fields; 19 photo URLs. Warnings are `missing_make` and `missing_model` because this page has no reliable separate values for them.
- Full JSON artifact: `docs/superpowers/checkpoints/auto24-checkpoint-1-listing.json` (6,205 bytes).
- Final image test suite: 63 passed. Independent Task 3 reviewer: spec PASS, quality PASS.

## Task 4: Turso job store

- Status: complete after review fixes.
- The embedded `pyturso` store uses explicit transactions and serializes connection access in one process. Claim, completion, and failure sample time inside their locked transaction; successful completion writes UTC `parsed_at`.
- Expired leases count toward the three-attempt limit. After attempt 3 expires, claim marks the job `failed` with `temporary_failure` and does not grant attempt 4. Transient reported failures retry twice after 5- and 30-second delays; permanent failures are terminal immediately.
- RED: four real-Turso regressions failed as expected: expired attempt 3 yielded attempt 4; delayed claim used a stale clock sample; delayed completion and failure accepted leases after expiry.
- GREEN: focused store suite passed 11 tests; full Python 3.12 Docker suite passed 74 tests with pyturso 0.7.2.
- Transaction visibility was checked from a second Turso connection, and a reopened `JobStore` retained the completed snapshot.
- Incremental source/test/config LOC: 517 (store 289, tests 227, one runtime dependency line). Active elapsed time including review fixes: about 35 minutes.
- The local TDD report is `.superpowers/sdd/2026-09-26-auto24-extraction-service/task-4-report.md`; that SDD directory is git-ignored.

## Task 5: Private storage service

- Status: complete.
- Added the authenticated FastAPI storage routes and synchronous HTTPX client. The runnable app opens the configured Turso file during lifespan, closes it at shutdown, and defaults to `/data/auto24.db`. The client uses a five-second timeout and maps timeouts, request failures, and server errors to `StorageUnavailableError`.
- RED: the first Python 3.12 Docker run failed collection because `storage_api` and `storage_client` were missing. A later default-path regression failed with Turso `IoError: open: NotFound` when the configured path's parent directory did not exist; lifespan now creates it.
- GREEN: the storage API, client, and store suites passed 22 tests before the additional default-path regression. That regression passed individually after the fix. The final full Python 3.12 Docker suite passed 86 tests (`86 passed in 1.00s`).
- The suite covers credentials on every private route, anonymous health, create/claim/complete/get/fail, empty-queue 204, public job shape, client URL and lease-token payloads, timeout/error handling, database ownership and close, persistence, and default-path startup.
- Final source/test/config LOC after the review fix: 585 (storage API 143, client 103, API tests 217, client tests 121, and one runtime dependency line). The review fix added 38 nonblank lines (8 in the API and 30 in its tests) relative to the initial 547-line report. This is above the original 220–360 estimate; the controller was notified during implementation and revised the provisional ceiling to 600, which contains the final count.
- Active elapsed time: approximately 18 minutes (about 2026-09-27 01:56–02:14 UTC). Self-review found no remaining implementation concerns. The report is `.superpowers/sdd/2026-09-26-auto24-extraction-service/task-5-report.md`; both report and scratch SDD directory are git-ignored.

## Task 6: Queue worker and durable queue demo

- Status: complete.
- Active elapsed time: approximately 21 minutes (2026-09-27 17:07–17:28 UTC), within the 30–60 minute estimate.
- Added nonblank source/test/config LOC: 230 (worker 100, worker tests 130); within the 180–300 estimate.
- RED: `pytest tests/test_worker.py -q` failed collection with `ModuleNotFoundError: No module named 'auto24_service.worker'` before the worker implementation.
- GREEN: the focused worker suite passed 7 tests (`7 passed in 0.60s`). Store, private storage API/client, and worker suites together passed 32 tests (`32 passed in 1.05s`).
- Test environment: Python 3.12 Docker container based on `auto24-extraction-service:task-3-final`, with pytest and the existing service dependencies installed in the disposable container. The host Python is 3.14 and lacks the project dependencies.
- The worker uses the existing `capture_html` and `parse_listing` functions. It claims at most one job per `run_once`, passes the lease token on completion/failure, retries only `temporary_failure`, marks parser and stable listing errors terminal, logs job IDs/state only, and uses a two-second idle wait in `run_forever`.

### Checkpoint 2 live demo

- Storage ran on `127.0.0.1:8001` with `TURSO_DB_PATH=/tmp/auto24-task6-demo/jobs.db` in the disposable container. Health returned `200 {"status":"ok"}`.
- Exact storage command; each `REDACTED` occurrence stands in for the same private key used for requests:

```sh
docker exec -e TURSO_DB_PATH=/tmp/auto24-task6-demo/jobs.db -e INTERNAL_API_KEY=REDACTED -e PYTHONPATH=/app/src -w /app auto24-task6-test python -m uvicorn auto24_service.storage_api:app --host 127.0.0.1 --port 8001 --workers 1
```

- Submitted `https://www.auto24.ee/soidukid/4344096` and `https://www.auto24.ee/soidukid/4311841` with authenticated `POST /internal/jobs`; both returned `queued`:

```json
[
  {"job_id":"10c0004b-b982-46ac-ad96-6717d3d9dd59","status":"queued","submitted_at":"2026-09-27T17:16:01.303313Z"},
  {"job_id":"b48d8165-7ec4-4c97-9b4f-85743621c5d9","status":"queued","submitted_at":"2026-09-27T17:16:01.331953Z"}
]
```

- Exact authenticated POST command used for those two URLs (the key value is redacted):

```sh
docker exec -e INTERNAL_API_KEY=REDACTED auto24-task6-test python -c 'import httpx,json,os; headers={"X-Internal-Key":os.environ["INTERNAL_API_KEY"]}; urls=["https://www.auto24.ee/soidukid/4344096","https://www.auto24.ee/soidukid/4311841"]; jobs=[httpx.post("http://127.0.0.1:8001/internal/jobs",headers=headers,json={"url":url}).json() for url in urls]; print(json.dumps([{key:job[key] for key in ("job_id","status","submitted_at")} for job in jobs]))'
```

- Ran this command once for each queued job. Camoufox fetched both current public pages and the worker completed both jobs:

```sh
docker exec -e STORAGE_URL=http://127.0.0.1:8001 -e INTERNAL_API_KEY=REDACTED -e PYTHONPATH=/app/src -w /app auto24-task6-test python -m auto24_service.worker --once
```

- Authenticated `GET /internal/jobs/{id}` returned both completed snapshots. Representative fields:

```json
[
  {"job_id":"10c0004b-b982-46ac-ad96-6717d3d9dd59","status":"completed","parsed_at":"2026-09-27T17:16:19.854260Z","listing":{"listing_id":"4344096","title":"Skoda Enyaq 195kW","year":2022,"mileage_km":46800,"price":{"amount":41500,"currency":"EUR"},"photo_count":19},"warnings":["missing_make","missing_model"]},
  {"job_id":"b48d8165-7ec4-4c97-9b4f-85743621c5d9","status":"completed","parsed_at":"2026-09-27T17:16:34.825370Z","listing":{"listing_id":"4311841","title":"Peugeot 3008 1.2 100kW - Moller Auto Viru","year":2024,"mileage_km":63150,"price":{"amount":26900,"currency":"EUR"},"photo_count":25},"warnings":["missing_make","missing_model"]}
]
```

- Exact authenticated GET command used to fetch those completed jobs. It prints a phone-free representative summary while reading each full response:

```sh
docker exec -e INTERNAL_API_KEY=REDACTED auto24-task6-test python -c 'import httpx,json,os; headers={"X-Internal-Key":os.environ["INTERNAL_API_KEY"]}; ids=["10c0004b-b982-46ac-ad96-6717d3d9dd59","b48d8165-7ec4-4c97-9b4f-85743621c5d9"]; jobs=[httpx.get("http://127.0.0.1:8001/internal/jobs/"+job_id,headers=headers).json() for job_id in ids]; print(json.dumps([{ "job_id":job["job_id"], "status":job["status"], "parsed_at":job["parsed_at"], "listing":{"listing_id":job["listing"]["listing_id"],"title":job["listing"]["title"],"year":job["listing"]["year"],"mileage_km":job["listing"]["mileage_km"],"price":job["listing"]["price"],"photo_count":len(job["listing"]["photo_urls"])},"warnings":job["warnings"]} for job in jobs],ensure_ascii=False))'
```

- Submitted the Enyaq URL twice more. The IDs were `edfcf13a-abf0-4a04-850d-ee8d21806b66` and `990bc2bd-ce97-4e02-b3e2-0e2f421ff949`; both were queued, and `distinct` was `true`.
- Exact duplicate-submit command (same URL twice):

```sh
docker exec -e INTERNAL_API_KEY=REDACTED auto24-task6-test python -c 'import httpx,json,os; headers={"X-Internal-Key":os.environ["INTERNAL_API_KEY"]}; url="https://www.auto24.ee/soidukid/4344096"; jobs=[httpx.post("http://127.0.0.1:8001/internal/jobs",headers=headers,json={"url":url}).json() for _ in range(2)]; print(json.dumps({"ids":[job["job_id"] for job in jobs],"distinct":jobs[0]["job_id"] != jobs[1]["job_id"],"statuses":[job["status"] for job in jobs]}))'
```

- Before stopping storage, saved a SHA-256 of the first full response and its `parsed_at`. Exact command and output:

```sh
docker exec -e INTERNAL_API_KEY=REDACTED auto24-task6-test python -c 'import hashlib,httpx,json,os; from pathlib import Path; job_id="10c0004b-b982-46ac-ad96-6717d3d9dd59"; response=httpx.get("http://127.0.0.1:8001/internal/jobs/"+job_id,headers={"X-Internal-Key":os.environ["INTERNAL_API_KEY"]}); document=response.json(); canonical=json.dumps(document,ensure_ascii=False,sort_keys=True,separators=(",",":")); digest=hashlib.sha256(canonical.encode()).hexdigest(); meta={"job_id":job_id,"parsed_at":document["parsed_at"],"sha256":digest}; Path("/tmp/auto24-task6-demo/before.json").write_text(json.dumps(meta)); print(json.dumps(meta))'
```

```json
{"job_id":"10c0004b-b982-46ac-ad96-6717d3d9dd59","parsed_at":"2026-09-27T17:16:19.854260Z","sha256":"a5b874c68348e10350c41f8c6473632fe60ff0b6f111ac189e9d1f66deea0600"}
```

- The first restart attempt found PID 118 still serving `/health`; the interrupt had stopped the attached `docker exec` client, not the server. The exact stop command targeted only that storage PID:

```sh
docker exec auto24-task6-test python -c 'import os,signal; os.kill(118,signal.SIGTERM); print("sent SIGTERM to storage PID 118")'
```

- Restarted storage using the same `TURSO_DB_PATH` and private key; the restarted server used PID 654:

```sh
docker exec -e TURSO_DB_PATH=/tmp/auto24-task6-demo/jobs.db -e INTERNAL_API_KEY=REDACTED -e PYTHONPATH=/app/src -w /app auto24-task6-test python -m uvicorn auto24_service.storage_api:app --host 127.0.0.1 --port 8001 --workers 1
```

- Exact authenticated restart verification command. It fetches both completed jobs and both queued duplicates, compares `parsed_at` and the canonical full-response hash against the pre-restart file, and prints the result:

```sh
docker exec -e INTERNAL_API_KEY=REDACTED auto24-task6-test python -c 'import hashlib,httpx,json,os; from pathlib import Path; headers={"X-Internal-Key":os.environ["INTERNAL_API_KEY"]}; ids=["10c0004b-b982-46ac-ad96-6717d3d9dd59","b48d8165-7ec4-4c97-9b4f-85743621c5d9"]; jobs=[httpx.get("http://127.0.0.1:8001/internal/jobs/"+job_id,headers=headers).json() for job_id in ids]; first=jobs[0]; canonical=json.dumps(first,ensure_ascii=False,sort_keys=True,separators=(",",":")); digest=hashlib.sha256(canonical.encode()).hexdigest(); before=json.loads(Path("/tmp/auto24-task6-demo/before.json").read_text()); duplicates=[httpx.get("http://127.0.0.1:8001/internal/jobs/"+job_id,headers=headers).json() for job_id in ["edfcf13a-abf0-4a04-850d-ee8d21806b66","990bc2bd-ce97-4e02-b3e2-0e2f421ff949"]]; print(json.dumps({"jobs":[{"job_id":job["job_id"],"status":job["status"],"parsed_at":job["parsed_at"],"listing_id":job["listing"]["listing_id"]} for job in jobs],"restart_check":{"parsed_at_unchanged":first["parsed_at"]==before["parsed_at"],"full_response_sha256_unchanged":digest==before["sha256"]},"duplicate_jobs":[{"job_id":job["job_id"],"status":job["status"]} for job in duplicates]},ensure_ascii=False))'
```

```json
{"jobs":[{"job_id":"10c0004b-b982-46ac-ad96-6717d3d9dd59","status":"completed","parsed_at":"2026-09-27T17:16:19.854260Z","listing_id":"4344096"},{"job_id":"b48d8165-7ec4-4c97-9b4f-85743621c5d9","status":"completed","parsed_at":"2026-09-27T17:16:34.825370Z","listing_id":"4311841"}],"restart_check":{"parsed_at_unchanged":true,"full_response_sha256_unchanged":true},"duplicate_jobs":[{"job_id":"edfcf13a-abf0-4a04-850d-ee8d21806b66","status":"queued"},{"job_id":"990bc2bd-ce97-4e02-b3e2-0e2f421ff949","status":"queued"}]}
```

- Exact final test command and output:

```sh
docker exec -e PYTHONPATH=/app/src auto24-task6-test python -m pytest tests/test_store.py tests/test_storage_api.py tests/test_storage_client.py tests/test_worker.py -q
```

```text
33 passed in 1.03s
```

### Task 6 review follow-up

- Active time: approximately 4 minutes (2026-09-27 17:31–17:36 UTC), bringing Task 6 to approximately 25 active minutes total.
- RED: the new real-store test reproduced the reporting mismatch: `run_once` requeued a temporary failure (`status="queued"`), while the worker log said `status=failed`.
- GREEN: the worker suite passed 8 tests (`8 passed in 0.60s`); the final store, storage API/client, and worker suites passed 33 tests (`33 passed in 1.03s`).
- Changed failure logs to use the neutral `failure_recorded` or `failure_rejected` action label. The added regression test verifies that the temporary failure is queued and never logged as terminal.
- Added 24 nonblank test lines for this follow-up (worker source remains 100 lines; tests are now 154). Final Task 6 source/test LOC is 254, within the 180–300 estimate. Documentation LOC is excluded from this count.
- The Checkpoint 2 section above records the exact authenticated POST and GET commands, exact combined test command and output, and the PID-specific storage stop, same-file restart, and response-hash verification commands. The internal key is redacted in the commands.
- Final Checkpoint 2 cumulative LOC: Task 4 517 + Task 5 585 + Task 6 254 = 1,356, which is 276 above the original 1,080 estimate.
