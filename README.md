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

```sh
npm ci
npx supabase start
docker compose --env-file "$HOME/.config/auto24/auto24.env" -p auto24 up --build -d
```

In separate terminals:

```sh
npm run dev
```

```sh
npm run worker
```

## Local links

- [English app](http://localhost:3000/en)
- [Estonian app](http://localhost:3000/et)
- [Extraction API docs](http://localhost:8000/docs)

Next.js may choose another port if 3000 is occupied; check its terminal output.

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
npm test
npm run lint
npm run typecheck
npm run build
```

Integration tests require a disposable local Supabase database and no live
analysis worker. See the [test instructions](docs/local-development.md#private-analysis-reports).

## Configuration and access

Application settings live in `.env.local`; extraction keys use a private file
outside the repository. Use independent secrets and keep service keys server-only.
Set `DATA_REVIEW_ENABLED=false` for baseline-only reports, or configure a supported
reviewer. See the [configuration guide](docs/local-development.md).

Reports use private access links and browser cookies. Keep the original link to
open a report in another browser. Reports require online services; offline saving
is not implemented.
