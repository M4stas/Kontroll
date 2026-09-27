# Used-car analysis prototype design

Date: 2026-09-12
Status: Approved design, ready for implementation planning
Working product name: Kontroll

## Summary

Kontroll helps a used-car buyer decide whether a listing is worth pursuing. The buyer submits an Auto24 listing link and receives a verdict-led report that separates seller claims from verified evidence, identifies risks and missing information, prepares questions and photo requests for the seller, and produces a practical inspection and test-drive checklist.

The prototype is a full-TypeScript application built with Next.js and Supabase. Its baseline analysis is deterministic and remains useful without an AI response. A Luna model with high reasoning is an optional enrichment layer for research gaps, conflicting sources, image interpretation, and context-dependent observations. A complete report may take two to four minutes, but useful results appear progressively.

## Goals

- Turn one Auto24 listing link into a clear recommendation for a used-car buyer.
- Preserve a visible distinction between claims, evidence, and conclusions.
- Show why the verdict was reached and how confident the system is.
- Tell the buyer exactly what to ask the seller and which additional photos or documents to request.
- Prepare a mobile-friendly checklist for an in-person inspection and test drive.
- Let the buyer add seller answers, documents, and photos to update the same analysis.
- Support Estonian and English from the first prototype.
- Work without signup while keeping each report private by default.
- Minimize AI latency and cost through deterministic code and reusable research caches.

## Non-goals

- User accounts, login, billing, saved garages, and team features.
- A paid vehicle-history report.
- Automated CAPTCHA solving or bypassing access controls.
- Auto24 market-price estimation. This can be revisited separately after a compliant data source is available.
- Guaranteed direct ingestion from Facebook Marketplace, Osta.ee, autodiiler.ee, or every other marketplace. Unsupported or inaccessible pages use the paste-and-upload fallback.
- A legally binding mechanical assessment, warranty, or replacement for an independent workshop inspection.
- Automatic negotiation or contacting the seller on the user's behalf.

## Product principles

### Verdict first, evidence close by

The report starts with one of three buyer-oriented verdicts:

- Worth viewing
- Proceed cautiously
- Likely skip

Verdict and confidence are separate. A strong warning based on incomplete vehicle identification can have a low-confidence label. The interface does not use a decorative numeric score because that would imply more precision than the evidence supports.

### Claims are not facts

Listing text, seller answers, buyer-entered details, and user uploads are unverified inputs until another source supports them. The interface labels them accordingly. An inaccessible source means "not checked", never "no problem found".

### Action over diagnosis

The product does not merely list possible faults. Each relevant finding should produce at least one useful next action: a seller question, a requested image or document, an in-person check, or a recommendation for professional inspection.

### Useful without AI

URL validation, listing extraction, field normalization, contradiction detection, missing-information checks, source ranking, confidence calculation, verdict policy, and checklist assembly are code-driven. AI failure may reduce enrichment but must not prevent a baseline report.

## User flow

1. The buyer submits an Auto24 link. Number plate or VIN can be added immediately but is not required to begin.
2. The application creates an anonymous private analysis and returns its private URL immediately.
3. The Auto24 adapter retrieves the listing and extracts structured fields, description, and image references.
4. Vehicle facts appear as soon as they are available. The report shows continuing research stages without requiring the buyer to remain on the page.
5. If the listing cannot be accessed or parsed, the buyer is asked to paste the description and upload screenshots. The original URL remains attached as context.
6. The report fills progressively with vehicle identity, open checks, evidence, seller questions, photo requests, source status, and the inspection checklist.
7. The buyer can add seller replies, invoices, screenshots, and requested images later. Only the affected analysis stages are rerun.
8. The current verdict is updated while previous analysis runs remain available for audit and debugging.

## Report structure

The report uses the approved dark inspection-sheet direction. It avoids a generic dashboard, decorative car illustration, repeated KPI cards, gradients, glass effects, and an arbitrary score.

The content order is:

1. Verdict, confidence, and the single most important reason.
2. Identified vehicle facts with provenance.
3. Open checks and evidence-backed findings, ordered by buyer impact.
4. A ready-to-copy seller message.
5. Specific photo and document requests.
6. A mobile inspection and test-drive checklist.
7. Source coverage and confidence.
8. A control to add new answers, photos, or documents and rerun affected checks.

Each finding expands to show:

- what was observed;
- why it matters for this vehicle;
- whether it is a confirmed issue, an unresolved question, or general model background;
- the supporting or conflicting evidence;
- the next action for the buyer.

## Visual system

The prototype uses shadcn/ui primitives where they reduce implementation and accessibility work, but their default visual treatment is replaced.

- Base: deep ink navy `#141D29`
- Raised surface: blue-gray `#202D3D`
- Primary text: cool off-white `#EDF1F5`
- Secondary text: steel `#ABB9C9`
- Open-check accent: muted amber `#E8B878`
- Action and focus accent: pale blue `#94BCE8`
- Radius: 3-5 px for controls and genuine raised surfaces
- Typography: a highly legible sans-serif with restrained weight contrast
- Layout: asymmetric report body on desktop, strict single column below 768 px
- Motion: only direct feedback for expanding evidence, copying questions, checking tasks, uploading evidence, and report-stage changes

The verdict is the dominant element. Findings use a connected inspection rail to communicate unresolved checks. The rail is semantic, not decorative. It visually links each open question to its evidence and next action.

## System architecture

### Web application

Next.js, React, and TypeScript provide the public submission page, private report page, upload flow, localization, and server endpoints. Server Components render read-heavy report content. Small Client Components handle language switching, uploads, clipboard actions, disclosures, and checklist state.

### Supabase

Supabase provides Postgres, private object storage, and future account compatibility. The anonymous prototype does not expose broad table access to the browser. Server-side routes validate the private analysis token and perform scoped reads and writes.

### Analysis worker

A separate long-running TypeScript worker consumes rows from an `analysis_jobs` table. This avoids tying two-to-four-minute research work to a web request timeout. Jobs are idempotent, stage-based, and retryable. Each stage writes its own result and progress state so partial reports remain available.

The worker owns listing ingestion, normalization, deterministic checks, source adapters, cached vehicle research, optional Luna calls, and report assembly.

### Agent boundary

Luna is accessed through a narrow `InsightProvider` interface. Inputs are normalized vehicle facts, explicitly delimited untrusted content, and selected evidence. Outputs must match a versioned JSON schema and include evidence references for every proposed finding.

The model is used only when:

- the matching vehicle research is absent or stale;
- relevant sources conflict;
- an uploaded image needs interpretation;
- deterministic output can benefit from additional context-specific insight.

The model cannot write the final verdict directly. It proposes structured observations. Deterministic policy validates evidence references, maps accepted observations to findings, calculates confidence, and produces the verdict.

## Analysis pipeline

1. **Create analysis:** validate the URL, generate the private token, store the input, and enqueue ingestion.
2. **Capture listing:** use the Auto24 adapter to save a source snapshot and extract fields, description, and images.
3. **Normalize identity:** standardize make, model, year, generation, engine, gearbox, fuel, mileage, VIN, and number plate. Record field-level provenance and confidence.
4. **Run baseline checks:** detect missing fields, contradictions, suspiciously broad seller promises, and unverified maintenance claims.
5. **Collect background:** load a matching research cache entry and check eligible sources in parallel.
6. **Enrich selectively:** call Luna only for a cache miss, conflict, image review, or additional insight.
7. **Assemble report:** create findings, evidence links, questions, photo requests, inspection tasks, confidence, and verdict.
8. **Publish stages:** update the report after each meaningful stage and mark the analysis complete when all required stages finish or have an explicit unavailable state.
9. **Apply supplements:** store new buyer submissions, determine affected stages, rerun them, and create a new analysis run.

## Source policy

Sources are ranked by the kind of claim they can support rather than by a single global score.

1. Estonian Transport Administration data for vehicle identity and official background information, when legally and technically available.
2. Manufacturer recall databases, service campaigns, and official repair or maintenance material.
3. Established independent technical references.
4. Owner forums and user-submitted reports as leads for questions and checks, not proof that the inspected car has the same fault.
5. Listing, seller, and buyer claims as unverified vehicle-specific input.

The public Transport Administration background checker is treated as a source, not as an assumed supported API. If compliant automation is unavailable, the prototype marks the source as not checked and may provide a link or ask the buyer for the resulting information. The application does not automate CAPTCHA bypass.

Manufacturer and recall information must match enough of the vehicle identity to be applicable. A model-wide complaint cannot be presented as a defect in the specific car. Forum material must be summarized with its source and framed as a possible inspection target.

## Data model

### `analyses`

Stores the analysis identifier, hashed private token, locale, status, current run, current verdict, confidence band, timestamps, and optional future owner ID.

### `analysis_inputs`

Stores the submitted URL, optional pasted text, number plate, VIN, and input type. Raw user content remains distinct from normalized facts.

### `source_snapshots`

Stores retrieved source metadata, capture time, source type, content hash, extraction status, and private storage reference where needed. It supports reproducible parser tests and later audits.

### `vehicle_facts`

Stores normalized field-value pairs with source reference, verification state, match confidence, and run ID. Conflicting values can coexist rather than overwriting each other.

### `evidence`

Stores a normalized claim or observation, source reference, source class, applicability, confidence, and capture time. Evidence can support or contradict a finding.

### `findings`

Stores category, severity, state (`open`, `confirmed`, or `cleared`), buyer-facing explanation, next action, provenance, and run ID. A join table connects findings to evidence with `supports` or `contradicts` relation.

### `actions`

Stores seller questions, photo or document requests, workshop recommendations, and inspection tasks. Checklist completion is separate from whether the underlying issue is resolved.

### `submissions`

Stores seller answers, buyer notes, images, screenshots, and documents. Every submission starts unverified and records who supplied it in plain provenance terms.

### `analysis_runs`

Stores versioned pipeline results, stage states, trigger, timestamps, and failure details. New evidence creates a new run instead of overwriting the previous reasoning history.

### `vehicle_research_cache`

Stores reusable research keyed by make, model, generation, engine, gearbox, year range, and relevant mileage band. Entries include source references, freshness metadata, and schema version.

### `analysis_jobs`

Stores stage, status, attempts, lease expiry, retry timing, and idempotency key. A worker can safely resume a job after interruption.

## Confidence and verdict policy

Confidence depends on vehicle identification, source coverage, evidence agreement, and recency. It uses human-readable bands: low, moderate, or high.

Findings use buyer-impact severity:

- Critical: credible safety, identity, legal, or major financial risk.
- Important: unresolved issue that should materially affect viewing, inspection, or price.
- Context: useful background or routine check without vehicle-specific evidence of a fault.

The verdict is deterministic:

- **Likely skip** when confirmed critical evidence exists or several strong contradictions create unacceptable risk.
- **Proceed cautiously** when important checks remain unresolved, source coverage is weak, or material claims lack evidence.
- **Worth viewing** when no critical evidence exists, important claims are sufficiently supported, and remaining checks are appropriate for a normal inspection.

Low confidence is always prominent. The report never converts absent evidence into reassurance.

## Supplementary images and answers

The buyer can request exact views from the seller, including the instrument cluster with the engine running, engine bay, underside on a lift, corrosion-prone areas, tire wear, panel gaps, VIN markings, and maintenance invoices.

When new material is uploaded:

1. The upload is stored privately and labeled as seller- or buyer-provided.
2. Basic file safety and metadata processing run before analysis.
3. Image interpretation returns observations, confidence, and the image region or frame that motivated each observation when possible.
4. Observations become open findings unless another source or an in-person check confirms them.
5. Only affected report stages rerun.

Uploaded content is treated as untrusted data. Text inside listings, documents, screenshots, or images cannot alter system instructions or request actions outside the analysis.

## Error handling

- A blocked or unavailable source receives an explicit `not_checked` state.
- Parser failure opens the paste-and-upload fallback without discarding the original URL.
- Conflicting facts remain visible with both sources and reduce confidence.
- An uncertain engine, gearbox, or generation prevents exact-model advice from being applied as vehicle-specific evidence.
- Luna timeout or schema failure records an enrichment warning and leaves the deterministic report intact.
- A failed pipeline stage can be retried independently.
- Job leases expire so another worker can safely resume abandoned work.
- Duplicate submissions and retries use idempotency keys.
- User-facing errors explain what is missing and the next available action.

## Privacy and access

- Each anonymous analysis uses a cryptographically random private token in the URL; only its hash is stored.
- Supabase Storage buckets are private. The server issues short-lived signed URLs after token validation.
- Row Level Security denies broad anonymous table access.
- Logs avoid private URLs, raw tokens, and unnecessary listing or upload content.
- Upload type and size limits are enforced server-side.
- The future account system can claim an analysis without changing its core identifier or history.
- The product tells users that anyone with the private URL can view the report and that seller documents should have unnecessary personal details covered.

## Localization and mobile use

All user-facing strings use typed translation keys with Estonian and English values. Vehicle data, source excerpts, and model-generated summaries retain their original language where evidence accuracy matters, with a translated summary when useful.

The report is mobile-first. The inspection checklist uses large touch targets and preserves progress locally. The latest successfully loaded report and checklist are cached for temporary offline use during a vehicle viewing. Uploads and fresh research still require connectivity.

## Testing strategy

### Unit tests

Cover URL validation, normalization, field provenance, source ranking, contradiction detection, confidence bands, verdict policy, finding generation, action generation, and stage selection after supplementary evidence.

### Parser contract tests

Use versioned saved Auto24 HTML fixtures. Tests verify required extraction fields and graceful fallback without depending on the live site.

### Integration tests

Cover Supabase persistence, token-scoped access, private storage, signed URLs, job leasing, retries, idempotency, progressive run updates, and future ownership attachment.

### Evidence invariants

Every critical or important finding must have at least one linked evidence record. Unverified seller or buyer claims must remain labeled. An unavailable source must never produce a clean result.

### Agent evaluations

Use a small stable evaluation set containing normal listings, missing data, conflicting facts, model-specific research, and supplementary images. Validate JSON schema, evidence references, unsupported-claim rate, and graceful timeout behavior. Agent evaluation does not replace deterministic tests.

### End-to-end tests

Cover the Auto24 happy path, parser fallback, progressive report, private URL, ET/EN switch, evidence disclosure, copied seller questions, supplementary uploads, verdict update, and mobile checklist.

Before the implementation is considered complete:

- automated task-relevant tests pass;
- a separate subagent returns a clean self-review;
- manual end-to-end testing passes on desktop and a mobile viewport;
- a pull request is created.

## Prototype acceptance criteria

1. A buyer can submit a supported Auto24 listing without signing up.
2. The application returns a private report URL immediately.
3. Vehicle facts and analysis stages appear progressively.
4. The report shows a verdict, confidence band, and supporting evidence.
5. Seller claims are visibly distinguished from verified information.
6. The report supplies relevant seller questions, photo or document requests, and an in-person checklist.
7. New answers or photos update the same analysis without recomputing unaffected stages.
8. Estonian and English interfaces are complete.
9. The report remains usable when Luna or an external source is unavailable.
10. The latest loaded report and checklist are usable during a temporarily offline viewing.
11. Private uploads are inaccessible without valid analysis access.
12. The completed implementation has a clean review, successful manual E2E result, and pull request.

## Reference pages

- Estonian Transport Administration vehicle background check: <https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf>
- Auto24 vehicle price inquiry, explicitly excluded from this prototype: <https://www.auto24.ee/ostuabi/?t=soiduki-turuhinna-paring>
- Auto24 terms of use: <https://www.auto24.ee/users/kasutustingimused.php>
