# Service checkpoint S1: registration number and VIN reveal

Status: built and reviewed. The premerge fixes passed offline checks, but the latest live benchmark reached only 3 of 10 on attempt 1 and failed the gate. This is not ready to merge. App integration has not started. See [Premerge fix results](#premerge-fix-results) and the historical [Handoff](#handoff).

Authority: [service roadmap](../service-roadmap.md), [spec](../specs/2026-10-11-auto24-registration-reveal-design.md), [plan](../plans/2026-10-11-auto24-registration-reveal-s1.md).

## What was built

The Auto24 extraction worker now reveals the registration number and VIN. It opens the listing in Camoufox, solves the reCAPTCHA in Python with the pinned solver files, checks the revealed values and returns them with their status. The job also carries a solve record. A failed reveal is retried once in a new session. A failed reveal never fails the job. The browser guard allows only the reCAPTCHA paths on `www.google.com` and `www.gstatic.com` besides Auto24. A network sandbox and a benchmark let you check traffic and accuracy yourself.

## Verification

Run on the final branch after the last review fixes:

- Python service tests: 394 passed in a full offline run.
- Unit tests (`npm test`): 759 passed after merging main.
- Lint: 0 errors. One warning, in a redesign demo file from main.
- Typecheck: passed.

## Offline sandbox

Latest passing report: `sandbox-reports/offline-20261016T143917Z/`. Result PASS, contacted hosts none, and the canary lookup (`sandbox-canary.invalid`) was seen in the log. The first run (`offline-20261012T091330Z`) failed because the bundled uBlock Origin and DNS prefetch contacted filter-list hosts. Captures now run without them, and later runs pass.

## Benchmark results

All runs used fresh mode, which is what the worker does. The gate is at least 8 of 10 reveals on attempt 1 within 3 rounds.

| Run | Attempt 1 | With retry | Notes |
|---|---|---|---|
| mac-1 | 8 of 10 | 9 of 10 | Saved-profile mode reached 7 of 10, so the worker keeps fresh profiles. The hash lookup hit 0 tiles. |
| mac-2 | 4 of 10 | 4 of 10 | Most failures came before the first round. This led to the per-stage error records and debug mode. |
| mac-3 | 6 of 10 | 7 of 10 | Run with `--debug`. Found two pass-detection bugs: a "try again" after a token counted as a pass, and a real pass counted as an error once Auto24 removed the widget. |
| mac-4 | 8 of 10 | 10 of 10 | Gate PASS. Every pass was confirmed by the value on the page and Auto24's JSON, because Auto24 removes the widget before the tick shows. |
| mac-5 | 5 of 10 | 5 of 10 | Gate FAIL. First run with the worker's lease deadline, on the branch merged with main. Four attempts stalled for the full 90 s, which left no time for the retry. Six reveals got a 4x4 motorcycles grid, and 1 of those rounds passed. |

mac-4 ran before the benchmark applied the worker's lease deadline. In one reveal, attempt 1 used its full 90 s before the retry passed, and the worker's lease would not have left time for that retry. Under production timing mac-4 is 8 of 10 on attempt 1 and 9 of 10 with the retry.

## Known limits

- 4x4 challenges for cars, boats, bridges, mountains and palm cannot be solved.
- Label ids confirmed against real listings: `/m/0k4j` cars, `/m/01pns0` hydrants, `/m/01bjv` buses, `/m/0199g` bicycles, `/m/014xcs` crosswalks and `/m/019jd` boats. Others are unconfirmed.
- The perceptual-hash table in the solver files is stale, so the lookup is off by default and the models decide every tile.
- 4x4 rounds pass less often than 3x3 rounds: 3 of 6 in mac-4.
- Inactive checkbox and verification waits now stop after about 20 s. Whole captures can still approach 105 s when navigation, multiple rounds and a retry consume time.
- Attempt 1 now reserves 36 s for a useful retry and its handoff/join allowance when the budget permits. The job deadline remains the lease end minus 15 s. Attempt 2 requires at least 30 s after its join allowance.
- Running without uBlock Origin and with WebRTC blocked may change how reCAPTCHA scores the browser. The live checks and the benchmark show whether it does.
- The attempt-2 thread can outlive a job only when a Playwright call hangs.

## How to check

1. Run `scripts/fetch-captcha-solver`. Confirm it prints `verified:` for the four solver files and for LICENSE.
2. Build and run the offline sandbox. Confirm PASS and contacted hosts none.

   ```sh
   INTERNAL_API_KEY=test PUBLIC_API_KEY=test docker compose -p auto24 build
   scripts/network-sandbox offline
   ```

3. Run the live sandbox with a listing URL. Confirm PASS with only `www.auto24.ee`, `www.google.com` and `www.gstatic.com`.

   ```sh
   scripts/network-sandbox live --url https://www.auto24.ee/soidukid/<listing id>
   ```

4. Put one listing URL per line in `benchmarks/urls.txt`, then run the benchmark. It prints one line per listing while it runs. Confirm PASS (at least 8 of 10 reveals on attempt 1 within 3 rounds each).

   ```sh
   docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 run --rm \
     -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker \
     -m auto24_service.captcha_benchmark --mode fresh \
     --listings /app/benchmarks/urls.txt --label <name>
   ```

5. Rebuild the Auto24 stack, then open the API docs page at `http://localhost:8000/docs` and submit a listing with hidden values. You can send the same request with the `POST /v1/jobs` curl in `docs/local-development.md` instead. Compare the returned registration number and VIN with the listing in your own browser.

   ```sh
   ENV_FILE="$HOME/.config/auto24/auto24.env"
   docker compose --env-file "$ENV_FILE" -p auto24 up --build -d
   ```

6. Submit a listing with no registration row. Confirm `not_listed` and a completed job.

If step 4 fails the gate, stop and review approach A before continuing.

## Where to send results

Share the report folders `sandbox-reports/<mode>-<UTC time>/` (live and offline) and `benchmarks/<name>-<UTC time>/`. They hold statuses and hosts, not revealed values. The `images/` folder holds challenge tiles. A `debug/` folder holds page screenshots with the value cells masked, but the screenshots still show the listing page, so check them before sharing. Debug folders from runs before the masking was added can show plates and VINs.

## Premerge fix results

The user approved checkpoint 1 of the [premerge plan](../plans/2026-10-16-registration-reveal-premerge-fixes.md), including an agent-run live benchmark, on October 16. Checkpoint 2, app integration, still requires separate acceptance. No new listing URLs or supplementary live runs were used after the failed primary gate.

Tested executable revision: `914b51d82664cfd68087896aed4faa76b8bbe957`. It includes the current main at implementation start, `b97168d`. The running local service was rebuilt from this revision. The application still ignores the additive registration fields.

### Changes and offline proof

- Bound inactive state, verification, trigger, image and value waits. Nested browser and debug waits inherit the relevant deadline. First-attempt budgeting reserves a useful retry, and retry browser launch/navigation receive the actual retry deadline.
- Snapshot dynamic tile identities before each click. Classify only changed, loaded replacements. A missing replacement ends at the bounded refill deadline rather than reusing a stale image.
- Correct the manual Docker build context. Benchmark reports now include verified solver hashes, exact revision, per-field statuses, capture wall times, grid counts, expired/skipped captures and actual retry execution.
- Full Python coverage on the final code: 426 passed, partitioned into 323 tests with networking disabled and 103 fake-site/driver/reveal tests in the network sandbox. No tests overlap between these groups.
- Offline sandbox: `sandbox-reports/offline-20261016T180450Z`, PASS, contacted hosts none, canary confirmed.
- App checks: 774 unit tests passed in the full run; the remaining CLI test passed when rerun outside the sandbox after a local IPC permission denial. Typecheck passed. Lint had no errors and two existing demo warnings.
- Independent task reviews and Astra low final review were clean after resolving retry and debug deadline findings. The internal browser returned `{"status":"ok"}` from the rebuilt API health endpoint.

### Live primary run

Report: `benchmarks/premerge-fixes-20261016T182058Z/report.json` and `report.md`, local and ignored by Git. Fresh profiles, lookup disabled, debug enabled, pinned solver assets, production lease deadline, and the six supplied URLs were used unchanged. Five available listings were each sampled twice; the sixth listing was expired. This is ten eligible reveals, not ten distinct vehicles.

| Measure | Result |
| --- | --- |
| First-attempt success | 3 of 10, gate FAIL against 8 of 10 |
| Additional successes through retry | 3 |
| Final complete successes | 6 of 10 |
| Retries started / skipped | 7 / 0 |
| Registration field statuses | 5 revealed, 2 not listed, 3 unavailable |
| VIN field statuses | 6 revealed, 4 unavailable |
| Grid coverage | 13 dynamic 3x3 rounds, 16 4x4 rounds |
| First-attempt mean | 37.52 s |
| Longest capture | 100.66 s |

The run demonstrates actual hidden-field retrieval for both identifiers, checked against the page and Auto24 JSON. It does not establish adequate reliability or replace the user's private value comparison.

| Supplied listing | Two eligible samples, unless noted |
| --- | --- |
| 4313094 | Both fields revealed once; both unavailable once |
| 4355947 | Registration not listed; VIN unavailable once and revealed through retry once |
| 4359986 | Both fields unavailable in both samples |
| 4100748 | Both fields revealed in both samples, one through retry |
| 4349917 | Both fields revealed in both samples, one through retry |
| 4019360 | Expired, `listing_gone`, excluded from eligible-reveal denominator |

The timing fix allowed all seven retries to start. Sanitized debug event timings show two inactive checkbox waits ending about 20.3 s after the checkbox click and one dynamic verification stall ending about 20.2 s after the pre-verify event. The 20 s bound applies to inactive stages, not the entire capture including useful work and retry startup. The earlier host benchmark and this Docker/debug run are not a paired performance comparison.

All 16 recorded 4x4 rounds were classified by the driver as `incorrect` or `timeout`. That does not prove all selections were wrong. Astra's evidence review found a `multicaptcha` entry with five label entries; in `fresh-11`, none of the three transitions showed an explicit incorrect or select-more message. Expected sequential progression versus rejection remains a concrete uncertainty. Dynamic challenges also showed explicit rejection, so resolving progression alone cannot be promised to recover the gate.

Follow-up rounds lacked parsed metadata and used instruction labels. This proves missing parsed metadata, not a parser bug or incorrect labels. The captured initial label sequences broadly agree with the later instructions.

### Stop condition and next decision

The primary gate failed, so no supplementary benchmark or app integration was started. Review approach A as required by the spec before further implementation. Astra recommends first distinguishing expected multicaptcha continuation from rejection with precise sanitized outcome reasons and an offline sequence regression. This is a smaller investigation than replacing the solver or changing thresholds without a demonstrated cause. Keep the three-round limit unless the user approves a change.

The historical claim below that a VIN failure loses a completed registration is not supported by the implementation. Completed fields are retained, and a dedicated regression now covers a VIN timeout. The benchmark counts partial results as failed listings while retaining their successful field status.

## Handoff

Written on 2026-10-16 before the premerge fixes, preserved as historical context. Read the current [premerge results](#premerge-fix-results) first. Branch `claude/captcharaptor-extension-build-dc327c`, [M4stas/kontroll#35](https://github.com/M4stas/kontroll/pull/35). The branch includes main as of 2026-10-16.

### Where the run logs are

These folders are in the worktree `~/cars/.claude/worktrees/captcharaptor-extension-build-dc327c` on the user's Mac. Git ignores them, so they are not on GitHub.

- `benchmarks/mac-1-*` to `benchmarks/mac-5-*`: `report.json` (per-attempt and per-round records: stage, reason, grid, label, label source, tile methods, durations), `report.md`, and `images/` with challenge tiles. They hold listing URLs, but no revealed values.
- `benchmarks/urls.txt`: the listing URLs the runs used.
- `sandbox-reports/offline-*` and `sandbox-reports/live-*`: `traffic.txt` and `summary.txt` for each network sandbox run.
- Solver files: `~/.cache/auto24/captcha-solver/current`, fetched by `scripts/fetch-captcha-solver` from the `captcha-solver-assets` branch. They are checked against `vendor/captcha-solver/SHA256SUMS`.
- The mac-3 `debug/` folder was removed, because its screenshots came before value masking. No run has debug output now.

Read one report without printing values:

```sh
python3 -I -c "import json,sys; r=json.load(open(sys.argv[1])); [print(v['n'], a['attempt'], a['outcome'], a['reason'], a['stage'], [(x['grid'], x['label'], x['label_source'], x['result'], x['stage']) for x in a['rounds']]) for v in r['reveals'] for a in v['attempts']]" benchmarks/mac-5-20261016T152929Z/report.json
```

### Open problems, from mac-5

1. **Stalls use the whole 90 s attempt.** Reveal 3 stalled at stage `captcha_state` with 0 rounds. It also did this in mac-4 and is probably the same listing. Reveal 5 and reveal 8's second attempt stalled at round stage `verify_wait`: no tick, no "try again" and no new tiles. `wait_for_state` and `wait_for_verify` in `src/auto24_service/captcha/recaptcha.py` have no cap of their own, so a dead attempt leaves the lease no time for attempt 2. Proposed fix: end the attempt when nothing changes for about 20 s.
2. **The reg number is lost when the VIN step stalls.** Reveal 9 solved a round, and the reg number appeared (`pass_evidence: value_only`). The attempt then timed out at `captcha_state` and the reveal counted as failed. Check in `captcha/reveal.py` whether the VIN click opens a second widget, and keep the reg number when only the VIN fails.
3. **4x4 rounds fail, and later rounds lose the label id.** Round 1 has `label_source: id`. Rounds 2 and 3 fall back to `instruction`, which looks like an earlier pmeta bug (fixed in c9e52f3) for follow-up rounds. Check how the follow-up challenge from `userverify` or `reload` is parsed in `captcha/recaptcha.py`.
4. **Variance is high.** Attempt 1 scores were 8, 4, 6, 8 and 5 of 10. The spec says a failed gate means reviewing approach A (the CaptchaRaptor extension) before continuing. That decision belongs to the user.

### Next live run

The user runs every live command. Use `--debug` so the stalls are recorded. Value cells are masked, but the screenshots still show the listing page.

```sh
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 up --build -d
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 run --rm \
  -v "$PWD/benchmarks:/app/benchmarks" --entrypoint python worker \
  -m auto24_service.captcha_benchmark --mode fresh \
  --listings /app/benchmarks/urls.txt --label <name> --debug
```

### Rules the user set

- Never put real plates or VINs in the repo, commits, logs, reports or chat. The user's samples folder outside the repo stays private.
- Agents do not run live captures, the live sandbox or benchmarks. The user runs them. Agents may run the offline sandbox (`scripts/network-sandbox offline`) and offline tests.
- Python tests run in Docker. Rebuild the image from this worktree first, because other worktrees share the `auto24-extraction-service:compose` tag. `scripts/pytest-service` installs test packages from PyPI. For the offline full-suite command and worker limit, see [local development](../../local-development.md).
- No new outbound hosts. The request guard allows `www.auto24.ee`, plus the `/recaptcha/` paths on `www.google.com` and `www.gstatic.com`.
- Run no third-party CaptchaRaptor code. Only its pinned data files are used.
- Ask the user before pushing. Never delete remote branches.
- Do not use em dashes in docs, commits or PRs. Use the `pr` skill for PR bodies.

