# Kontroll used-car analysis prototype

Kontroll takes an Auto24 listing URL and builds a private, progressive inspection report in Estonian or English. A report is an aid for deciding what to verify with the seller and during a viewing; listing, seller, buyer, and uploaded claims are unverified until corroborated.

## Local startup

Use Node.js with npm, Docker, and the Supabase CLI. From the repository root, run these commands in order for a **fresh local Supabase project**:

```bash
npm install
npx supabase start
npx supabase db reset
cp .env.example .env.local
```

`supabase db reset` destroys and recreates the local database. Run it only for a fresh or intentionally disposable setup; do not use it on a database containing reports you want to keep. For an existing local instance, check its status and migrations instead.

Fill `.env.local` with the local Supabase `API_URL` as `NEXT_PUBLIC_SUPABASE_URL` and `SERVICE_ROLE_KEY` as `SUPABASE_SERVICE_ROLE_KEY` from `npx supabase status -o env`. Set `ANALYSIS_COOKIE_SECRET` to a private random value of at least 32 characters and `WORKER_ID` to a stable, nonempty identifier for this worker. Keep the service role key and cookie secret server-side; never put them in a `NEXT_PUBLIC_` variable.

Then start the app. It runs at `http://localhost:3000/en` or `/et`:

```bash
npm run dev
```

Run the worker in a second terminal:

```bash
npm run worker
```

`AUTO24_FETCH_ENABLED=false` is the default. Set it to `true` to attempt direct Auto24 capture; a blocked, changed, or inaccessible listing still produces a fallback path. Start the analysis with its URL, then add pasted listing text and screenshots through **Add seller information** on the report. Do not use CAPTCHA solving or access-control bypasses. A full worker run can take two to four minutes; keep the worker running and watch the report update stage by stage.

`OPENAI_API_KEY` and `OPENAI_INSIGHT_MODEL` are optional Luna enrichment settings. Leave both empty for the deterministic baseline. If Luna times out, refuses, returns invalid output, or is unavailable, the baseline report remains usable and the enrichment warning is shown; it must not block the report.

The prototype stores uploaded PDFs privately but does not read or corroborate their contents. Add the relevant maintenance details as a seller answer for unverified review. Optional Luna findings are supplementary; an unavailable official or applicable source remains `not_checked`.

## Checks

With local Supabase running and `.env.local` configured, run:

```bash
npm run test
npm run test:integration
npm run test:e2e
npm run typecheck
npm run lint
npm run build
git diff --check
```

The integration and browser tests use the local Supabase instance. Browser tests create and remove test reports; use a disposable local environment when possible. The E2E server uses port 3000, so stop a manually started dev server before running it if that port is occupied.

## Prototype limits

There is no signup or account requirement. Each private report is opened through its secret link, and uploads belong to that report. Save the link securely; a bare report URL in another browser session does not grant access. The offline copy is stored only in the browser where it was saved and can be removed from the report.

Transport Administration checks may be `not_checked` when an official source is unavailable; that does not mean the vehicle passed the check. The Auto24 price estimate and paid report are outside this prototype. Results are not a vehicle inspection, title guarantee, or verified history.
