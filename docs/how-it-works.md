# How Kontroll works

What happens between pasting a listing link and reading the report. [Local development](local-development.md) covers setup.

## Components

| Component | Role |
| --- | --- |
| Next.js | Frontend and application API |
| Analysis worker | Report reviews and supplements |
| Supabase | Report data and private uploads |
| Auto24 stack | Listing API, scraping worker, and Turso storage |

## Reports and access

The dashboard is at `/[locale]/a/[jobId]` and the report at `/[locale]/r/[publicId]`.

```mermaid
%%{init: {"sequence": {"mirrorActors": false}}}%%
sequenceDiagram
  autonumber
  participant B as Browser
  participant A as Next.js
  participant D as Supabase
  Note over B: The URL fragment never reaches a server.
  B->>B: Read token from #35;access=
  B->>A: POST token
  A->>D: Load stored token hash
  D-->>A: Hash
  A->>A: Compare token with hash
  A-->>B: Set HttpOnly cookie
  B->>B: Drop the fragment and reload
  B->>A: GET report, cookie only
  A-->>B: Report
```

The URL alone grants no access. Seller answers, buyer notes, screenshots and photos create a new run at the same report URL. See [report access and limitations](local-development.md#report-access-and-limitations).

## Background check PDFs

Kontroll fetches the Transpordiamet taustakontroll PDF while the text and photo reviews run. The final assessment waits for the lookup to finish or reach its deadline. It can cite the fetched PDF, and ordinary code adds a finding when the PDF's VIN differs from the supplied vehicle VIN. If no PDF is available, the report shows the lookup status and reason. See the [background check contract](superpowers/specs/2026-10-22-transpordiamet-background-check-design.md#contract) for lookup statuses and deadlines.

PDFs stay private. Fetched PDFs enter the final assessment as official evidence; manually uploaded PDFs enter as unverified, page-labelled evidence. Later seller replies and retries keep both kinds of PDF and drop duplicate review input.

A PDF that arrives after review input is locked starts a new run at the same report URL and can reopen progress. The replacement reuses completed text and photo reviews and retries unfinished passes before its final assessment. If the PDF child run fails, the last published assessment stays visible in the partial report.

PDFs must have selectable text, be unlocked, and fit within 12 MiB, 50 pages and 10,000 extracted characters, including page labels. The app rejects other files instead of truncating them. Instructions inside a document count as source text.

## Review pipeline

```mermaid
flowchart LR
  L[Captured listing] --> T[Text review] & P[Photo reviews<br/>up to 8 at once]
  T & P --> F[Final assessment]
  F --> R([Report])
```

Final assessment waits until the text and all selected image results are stored. After an infrastructure failure, the worker starts no new photo reviews, lets started ones finish, then rethrows the error. The [image review checkpoint](superpowers/archive/image-review-performance/checkpoint.md) has the performance measurements.

Capture and review jobs retry after 15 seconds, 1 minute and 5 minutes, and review retries reuse committed results. If a required capture runs out of retries, final assessment does not start.

## Live diagnostics

`LIVE_DIAGNOSTICS_ENABLED=true` adds a private drawer with saved findings and attempt timings. See [the setup](live-diagnostics.md#live-diagnostics-checkpoint-1).

## Saved reports offline

A report saved online reopens on the same device without a connection. The saved copy omits the background check PDF link. See [the test setup](local-development.md#saved-reports-offline).
