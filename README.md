# Kontroll

Inspect a used-car listing before you go see it.

Kontroll captures Auto24 listings and creates private inspection reports from
listing details, photos, buyer notes, and seller answers. Available in Estonian
and English.

## Features

- Capture Auto24 car details and photos, or continue manually.
- Review listing text and images in a private report.
- Add buyer notes, seller answers, screenshots, and photos to update the report.
- Open the interface in Estonian or English.

## Run locally

Requires Node 24, Docker, and configured private environment files.
Follow the [setup guide](docs/local-development.md#run-the-whole-project-locally)
for keys, Supabase, migrations, and reviewer configuration before starting.

Run the three `scripts/fetch-*` commands once before `docker compose ... build`.
The builds read their cache folders as additional contexts. The setup guide shows
how to create the private `auto24.env` file with the extraction keys.

```sh
pnpm install --frozen-lockfile
pnpm supabase start
scripts/fetch-captcha-solver
scripts/fetch-browser-assets
scripts/fetch-browser-build-inputs
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 up --build -d
cp .env.example .env.local
pnpm supabase status -o env
```

Fill in `.env.local` before starting the app. `SUPABASE_SERVICE_ROLE_KEY` is the
`SERVICE_ROLE_KEY` value that `pnpm supabase status -o env` prints, and
`AUTO24_SERVICE_API_KEY` is the `PUBLIC_API_KEY` from `auto24.env`.

In separate terminals:

```sh
pnpm dev
```

```sh
pnpm worker
```

## Local links

- [English app](http://localhost:3000/en)
- [Estonian app](http://localhost:3000/et)

Next.js may choose another port if 3000 is occupied; check its terminal output.
The extraction API on port 8000 needs an `X-API-Key` header on every path except
`/health`, so its `/docs` page does not open in a plain browser tab.

Open `/et` or `/en`, submit a listing, then open its report from the dashboard.
The dashboard stays at `/[locale]/a/[jobId]`; the report uses
`/[locale]/r/[publicId]`. The initial report link exchanges its private token
fragment for an HttpOnly access cookie. The URL alone grants no access. Report
reads and uploads require that cookie and disable shared caching. Seller answers,
buyer notes, screenshots, and photos create a new run at the same report URL.
The report has a dedicated taustakontroll PDF uploader available during photo
review and after completion. Readable PDFs remain private and are included as
unverified, page-labelled evidence in the final assessment. Completed text and
photo reviews are retained for PDF-only uploads; only the final assessment runs
again. Uploading other information keeps the existing supplement behavior.

PDFs must have selectable text, be unlocked, and fit within 12 MiB, 50 pages,
and 10,000 extracted characters (including page labels). Unreadable or oversized
documents are rejected rather than silently truncated. Embedded document
instructions are treated as source text, not reviewer instructions.

| Component | Role |
| --- | --- |
| Next.js | Frontend and application API |
| Analysis worker | Report reviews and supplements |
| Supabase | Report data and private uploads |
| Auto24 stack | Listing API, scraping worker, and Turso storage |

Docker Compose starts only the Auto24 stack. The frontend, Supabase, and analysis
worker must also run.

## Development checks

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Integration tests require a disposable local Supabase database and no live
analysis worker. See the [test instructions](docs/local-development.md#private-analysis-reports).

## Configuration and access

Application settings live in `.env.local`; extraction keys use a private file
outside the repository. Use independent secrets and keep service keys server-only.
Set `DATA_REVIEW_ENABLED=false` for baseline-only reports, or configure a supported
reviewer. See the [configuration guide](docs/local-development.md).

Reports use private access links and browser cookies. Keep the original link to
open a report in another browser. Save a report on this device to keep a copy for
30 days and find it on the front page. Save and Update also renew this browser's
report access cookie for 30 days.

Photo review runs up to three images concurrently per analysis after the text
review. Final assessment waits for all selected image results to be stored.
The model, reasoning effort, prompts, and image resolution stay the same. See the
[performance measurements and benchmark commands](docs/superpowers/archive/image-review-performance/checkpoint.md).

Temporary photo preparation failures retry before the worker pins a review
snapshot. Capture and review jobs retry after 15 seconds, 1 minute, and 5 minutes.
Review retries reuse committed successes. Exhausted required capture failures
stop processing without starting final assessment.

Set `LIVE_DIAGNOSTICS_ENABLED=true` on the server to open the private live review
drawer. Inspect saved text/photo/final findings and attempt timings as a review
progresses. It is off by default and needs no new migration. See the
[live diagnostics setup and timing limits](docs/local-development.md#live-diagnostics-checkpoint-1).

Saved reports can be reopened on the same device without a connection after saving online. Use a production build for service-worker testing; see [local development](docs/local-development.md#saved-reports-offline) for phone HTTPS setup, browser-storage limits, and `pnpm test:e2e`.
