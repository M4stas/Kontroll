# Service checkpoint S1: registration number and VIN reveal

Status: built and reviewed. The latest live benchmark (mac-5) failed the gate, so this is not ready to merge. See [Handoff](#handoff).

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
- A checkbox that never resolves uses the whole 90 s attempt, which leaves no time for the retry.
- The retry covers fast failures only. The job deadline is the lease end minus 15 s. Attempt 2 runs only if at least 30 s remain.
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

## Handoff

Written on 2026-10-16 for whoever continues this work. Branch `claude/captcharaptor-extension-build-dc327c`, [M4stas/kontroll#35](https://github.com/M4stas/kontroll/pull/35). The branch includes main as of 2026-10-16.

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
- Python tests run in Docker. Rebuild the image from this worktree first, because other worktrees share the `auto24-extraction-service:compose` tag. `scripts/pytest-service` installs test packages from PyPI. To run with no network, use the `:sandbox` image: `docker run --rm --network none -v "$PWD:/app:ro" -w /app -e PYTHONPATH=/app/src --entrypoint python auto24-extraction-service:sandbox -m pytest -q -p no:cacheprovider`.
- No new outbound hosts. The request guard allows `www.auto24.ee`, plus the `/recaptcha/` paths on `www.google.com` and `www.gstatic.com`.
- Run no third-party CaptchaRaptor code. Only its pinned data files are used.
- Ask the user before pushing. Never delete remote branches.
- Do not use em dashes in docs, commits or PRs. Use the `pr` skill for PR bodies.

