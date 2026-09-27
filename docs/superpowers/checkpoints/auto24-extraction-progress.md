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
