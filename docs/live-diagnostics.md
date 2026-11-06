# Live diagnostics

## Live diagnostics, checkpoint 1

`LIVE_DIAGNOSTICS_ENABLED=true`, server-only, adds Live diagnostics to private reports after a Next.js restart. With it off, the entry point goes away and the endpoints return 404. Report access cookies are still required.

Regular refreshes are at least three seconds apart.

Attempt durations include reviewer preparation and saving, so they are not pure provider latency. Photo calls overlap, so their durations do not add up to the report wait. Reused results keep their original times. Missing measurements say Not recorded.

## Live diagnostics, Auto24 capture timings

The same flag controls capture timings. Compose reads it from the shell, not `.env.local`, so rebuild with it set:

```sh
LIVE_DIAGNOSTICS_ENABLED=true docker compose --env-file "$ENV_FILE" -p auto24 up --build -d
```

With it off, no span rows are written. To repeat the overhead check, run `python scripts/measure_capture_overhead.py` in an environment with the service's dependencies. It needs no Docker and makes no Auto24 request.
