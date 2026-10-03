# Used-car analysis implementation plan: configurable data reviewer

> For agentic workers: use subagent-driven-development or executing-plans after implementation is authorized. Checkbox steps below are planned work, not completed work.

**Status:** Implementation through checkpoint 2 authorized by the user on September 30. Recommendations 1-10 are accepted. Each reviewed image produces its own findings. After every scheduled image and text review completes, the configured text model reviews all their results together. Implementation progress and review evidence are recorded separately. Overall buying-verdict ownership remains a separate decision.

**Goal:** Build Kontroll's private, progressive used-car report around captured listing data and additional buyer/seller evidence, with a developer-configured data reviewer that can use one model or separate text and image models.

**Architecture:** Next.js owns the dashboard, private report, ET/EN interface, and uploads. Supabase owns analyses, evidence, files, runs, and durable jobs. Ordinary code fetches through the existing Auto24 API, prepares evidence, validates outputs, and publishes reports. The data reviewer is the only AI subsystem; it reviews text and each selected image separately, then assesses all completed results through its configured text model. Unified mode shares one model across these phases; split mode separates text and image models. Future external services and manual retrieval supply evidence to the same boundary.

**Tech stack:** Reuse the existing Next.js/React/TypeScript application, Supabase, Zod, worker, private upload capabilities, and existing OpenAI API adapter. Additional provider adapters are introduced only when a developer actually selects a provider that needs one.

**Copied and revised from:** [archived prototype plan](../archive/2026-09-12/2026-09-12-used-car-analysis-prototype.md), including the approved September 28 checkpoint scope and subsequent chat amendments. The original plan stays unchanged by this draft. The original spec remains a reference for unchanged product behavior; the requirements explicitly changed here supersede conflicting Luna/research wording for this proposal.

## Global constraints and decisions

- No signup requirement. Reports and uploads remain private; raw access tokens and credentials stay out of logs and committed evidence.
- The only AI subsystem is the data reviewer. No AI fetching, web search, external-source discovery, separate research agent, or AI routing agent. Final synthesis belongs to the data reviewer and uses its configured text model.
- Current inputs are captured listing details/images, buyer notes, seller answers, and supplied screenshots/images. Seller material remains unverified until independently corroborated.
- Future inputs are the Transpordiamet summary, applicable factory-manual excerpts, and a paid VIN lookup added very late in development. None is a dependency of checkpoint 2.
- Missing or inaccessible external data is `not_checked`; missing evidence is not a clean result.
- Model choice, split-review configuration, reasoning settings, and prompt editing are developer-only server configuration or source changes. There is no user-facing model selector, settings page, API field, or prompt editor.
- User submissions cannot override model IDs, providers, prompts, system instructions, or review settings.
- Support one multimodal model as the default and optional separate text/image models. Do not introduce model ensembles, automatic model selection, or a third combining model.
- Model output uses a strict, provider-independent schema and references only evidence supplied to that particular review pass. Code resolves source metadata; a model does not create source URLs or verification states.
- Valid IDs and schema do not prove a conclusion is supported. Semantic correctness is evaluated separately using representative cases and human review.
- Preserve the dark inspection-sheet direction, ET/EN interface, existing dashboard recovery states, and the established checkpoint sequence.
- PDFs stay private, unread, and unverified in the current prototype. Future factory-manual processing is separately scoped; this plan does not authorize a general PDF interpretation feature.
- Existing verdict values remain `worth_viewing`, `proceed_cautiously`, and `likely_skip`; confidence bands remain `low`, `moderate`, and `high`.
- Verdict ownership is NOT newly approved here. Retain current deterministic verdict/confidence rules for this draft. The alternative of a model-proposed verdict with conservative code limits remains a separate decision; do not silently implement it.
- No new dependency on market-price estimation, paid Auto24 reports, CAPTCHA solving, or access-control bypasses.
- Checkpoint 2 completion requires current task-relevant tests, independent subagent review, manual desktop/mobile E2E, and a scoped PR. Later checkpoints remain outside the current implementation authorization.

## Accepted discrepancy resolutions

The user accepted recommendations 1-10, with this amendment to recommendation 3: final review must only be processed after all scheduled text and image reviews have completed. This replaces the earlier proposal to publish model findings as each pass arrives.

1. Preserve the complete validated listing capture once, including original description, title, price, equipment, technical/other fields, nulls, seller metadata, and registration-year provenance. Prepare typed source records with citation IDs. Keep first-registration year distinct from manufacture/model year.
2. Acquire approved listing photo references through ordinary bounded server code. Validate and re-encode images, store them through existing private image storage, and issue scoped capabilities just before review. Track supplied, selected, accepted, skipped, rejected, and unavailable images separately. Failed downloads are not an absence of supplied photos. Define approved-host/redirect/network rules and byte/dimension/count limits before this code is implemented; preserve deterministic selection and content hashes.
3. Keep one enrichment coordinator with durable per-pass result records. Run text/image passes sequentially initially. Save completed pass results, but do not merge/publish their conclusions or start final review while another scheduled pass remains unfinished. Reuse committed success during retries without duplicate publication. Baseline facts and waiting/error status may remain visible.
4. Freeze selected input, image content hashes, locale, provider/model/settings, exact composed prompt version/hash, preparation version, and result schema before either pass starts. Use additive execution/attempt records with service-role ownership/RLS; retain legacy reports without inventing old metadata. New configuration affects new runs. Explicit developer re-review creates a new run at the same private report URL. No cross-report AI cache initially.
5. Preserve finding titles and structured recommended action kind/title/instructions. Use one evidence-ID set with image membership taken from stored metadata. Apply common schema/reference/provenance validation after every provider adapter. Valid citations do not establish correct interpretation.
6. Remove exact duplicates only, using canonical sorted evidence IDs and equal structured observation/action fields. Preserve nonidentical observations and pass attribution. Recognize only explicitly represented conflicts; ordinary code does not promise arbitrary semantic contradiction detection. Model agreement never corroborates source evidence.
7. Separate mandatory app/DB/access configuration from recoverable reviewer configuration. One resolver is shared by app and worker. Invalid image settings do not disable valid text work or baseline access. Never silently substitute models. Explicitly reject user-supplied model/provider/prompt controls in JSON and multipart requests.
8. Add private manual analysis creation without requiring a scraper job. Store supplied URL/failure context and accept buyer text/screenshots through existing supplements. Disabled capture makes no scraper requests. Temporary service errors offer retry or manual continuation; successful existing captures are reused without a new scrape.
9. Connect the private `/r/` report route, dashboard action, localization provider/request setup, and a coherent report styling pipeline through selective reuse. Show user-safe translated review states, not developer model settings/errors. Saved report locale governs generated content; interface language switching does not regenerate existing conclusions. Test actual ET and EN reports.
10. In checkpoint 3, require explicit offline save intent and persistent removal, adapt caching/links to `/r/`, and reuse current cache infrastructure. Save one report snapshot and its checklist marks; replacing it with a newer report is explicit. Preserve online access denial and legacy saved-report compatibility. Do not pull checklist/offline features into checkpoint 2 to satisfy historical tests.

Final-review completion rules:

- A scheduled review is complete only after its validated result is durably committed. Pending/running/retry work cannot satisfy the barrier.
- No supplied images means the image pass is not scheduled; its visible status is skipped, not successful image review. Supplied but unavailable images must be reported explicitly and must not be silently treated as an empty input.
- A failed/unavailable scheduled pass preserves the baseline and successful pass records, but does not count as successful completion. Show incomplete/unavailable review and retry/recovery instead of a finalized AI-reviewed conclusion. Review disabled by developer configuration yields an explicitly baseline-only report.
- Final processing starts only after the barrier succeeds and may publish once for the pinned input identity. A superseding supplement run prevents stale final publication.
- Final review is one combined AI assessment by the configured text model, after all scheduled text and individual image results are validated and committed. It receives all completed results together, with relevant original supplied evidence/context. No third model or separate agent is introduced. A failed final assessment remains incomplete and retries against pinned inputs; only one committed final result is published.
- Verdict ownership remains unapproved. Keep existing deterministic rules as a holding policy; this acceptance did not choose model-proposed verdicts.

## Current code and reuse baseline

The checkpoint 2 worktree is the current integration target: `~/.codex/worktrees/checkpoint-2-analysis/cars`, branch `codex/checkpoint-2-analysis`, base `6f952ae7e678e70fc48846e0ea1da74216316ce8`. It contains uncommitted work; inspect its actual status and do not claim it is a completed or tested revision.

The preserved full prototype is `~/cars/.worktrees/used-car-prototype`, branch `codex/used-car-prototype`. It contains historical analysis, supplements, research, offline work, and dirty edits. Reuse selectively; do not replace the checkpoint branch with the whole prototype or discard preserved work.

- Keep checkpoint 1's service client, authenticated listing routes, captured data contract, dashboard, and progress/error states.
- Reuse domain schemas, baseline/normalization/assembly, worker lifecycle, analyses/evidence/jobs repositories, access checks, uploads/image capabilities, supplement lineage, report components, and relevant tests.
- Current `src/insights/provider.ts`, `luna.ts`, and `prompt.ts` provide an existing boundary but are model-specific and use one configured model. They need adaptation, not an additional parallel AI stack.
- Historical runtime research, source discovery, and direct listing fetch code must not enter the delivered main-app worker. Preserve that historical code outside the current execution path.
- Checkpoint 2's captured-service handoff and report UI remain unfinished. Carry their pending work into this plan rather than treating imported files as accepted features.
- Keep applied migrations and reports. Use additive migrations; no database reset.

## Developer configuration and shared contracts

Use server-only defaults and overrides. These are proposed names, to be mapped once to existing environment configuration during implementation:

| Setting | Meaning |
|---|---|
| `DATA_REVIEW_ENABLED` | Developer enables/disables model review; disabled review is explicit in the report. |
| `DATA_REVIEW_MODE` | `unified` by default, or `split`. |
| `DATA_REVIEW_PROVIDER` / `DATA_REVIEW_MODEL` | Default provider and model; used by unified review. |
| `DATA_REVIEW_TEXT_MODEL` / `DATA_REVIEW_IMAGE_MODEL` | Optional model overrides in split mode; inherit the default model when omitted. |
| `DATA_REVIEW_TEXT_PROVIDER` / `DATA_REVIEW_IMAGE_PROVIDER` | Optional split provider overrides; inherit the default provider. Implement only adapters actually needed. |
| `DATA_REVIEW_REASONING_EFFORT` and per-pass overrides | Optional developer reasoning settings; adapters validate support rather than assuming every model supports the same settings. |

Existing provider credentials stay server-only. Do not overload development-agent model/effort settings as in-product review settings. Missing credentials, invalid settings, or unsupported capabilities produce an explicit unavailable review; they must not silently invoke a different model.

Keep shared input/output types provider-independent. Reuse `Evidence`, `Locale`, normalized vehicle identity, and the current private image-capability boundary:

```ts
type ReviewPass = 'text' | 'image' | 'final';

interface DataReviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}

interface ReviewInput {
  analysisId: string;
  runId: string;
  locale: Locale;
  pass: ReviewPass;
  imageEvidenceId?: string; // required for individual image review
  priorReviews?: readonly CompletedReview[]; // required for final synthesis
  vehicle: NormalizedVehicle;
  listing: Listing | null; // full validated service capture, when available
  sourceRecords: readonly ReviewSourceContent[];
  evidence: readonly Evidence[];
  images: readonly ReviewImage[];
}

interface CompletedReview {
  executionId: string;
  pass: 'text' | 'image';
  imageEvidenceId?: string;
  result: ReviewResult;
}

interface ReviewSourceContent {
  evidenceId: string;
  sourceId: string;
  kind: 'listing_text' | 'listing_fact' | 'seller_reply' | 'buyer_note'
    | 'official_record' | 'manual_excerpt' | 'vin_record';
  content: string | Record<string, unknown>;
}

interface ReviewImage {
  evidenceId: string;
  capability: unknown; // existing server-issued, scoped image capability
}

interface ReviewResult {
  schemaVersion: 1;
  observations: ReviewObservation[];
  warnings: ReviewWarning[];
}

interface ReviewObservation {
  id: string;
  evidenceIds: string[];
  category: string;
  title: string;
  severity: 'critical' | 'important' | 'context';
  explanation: string;
  recommendedAction: {
    kind: ActionKind;
    title: string;
    instructions: string;
  };
  confidence: number; // interpretation confidence; does not change source verification
}

interface ReviewWarning {
  code: 'timeout' | 'refusal' | 'invalid_output' | 'unavailable';
  message: string;
}
```

Reuse `Listing` from the app-side service contract and `ActionKind` from the domain. Prepare source records and corresponding canonical evidence IDs together; model citations resolve against the exact pass input. Define bounded typed projections for source content, including numeric fields, rather than string-only evidence serialization. Mirror these interfaces with strict Zod schemas, bounded strings/arrays, and unique observation IDs. Implement these types/schema together in the existing provider boundary, or an extraction from it if needed for readability. Do not create a second authoritative report schema. New observations map into existing findings/actions through deterministic validation and assembly. Model confidence is separate from report confidence and source verification.

### Unified and split execution

- Unified mode uses one configured model for text, individual image reviews, and final synthesis. These remain separate phases; unified mode does not mean one end-to-end call.
- Split mode schedules a text review and an individual review for each selected image; acquisition/authorization failure remains explicitly incomplete/unavailable, not an absent-image skip. Text review receives no image bytes. Each image review receives its accepted image plus relevant supplied vehicle/text context and citation IDs; that context is not a second text-review job.
- All reviews use the same run's immutable evidence snapshot. Each execution records exactly which evidence IDs it received.
- Each selected image gets a durable review result tied to its evidence ID, including its findings and visibility limits. A no-visible-concern result differs from an unavailable or unreviewed image. Split mode uses the image model for each image, and the text model for text review and final synthesis.
- After the completion barrier, the configured text model assesses all image and text results together, with relevant original supplied evidence/context. Validate referenced prior executions and original evidence against this run. Scope observation IDs by run/pass/image, remove exact structured duplicates, and preserve original observations and attribution alongside final synthesis. Model agreement never corroborates evidence.
- A failed pass does not discard a successful pass or the deterministic baseline. Clearly show text-review/image-review availability independently. With no images, skip the image pass; do not describe it as completed image review.
- Show captured facts/deterministic baseline and pass progress while work runs. Do not publish partial model conclusions as a final review. Final review processing waits for all scheduled validated results to be committed. Failed review remains clearly incomplete/unavailable; terminal job cleanup is not successful AI review.

### Developer-editable prompts

Store prompts as version-controlled server files, initially under `src/insights/prompts/`: shared review instructions plus task-specific `text.md`, `image.md`, and `final.md` instructions. The final prompt assesses all completed reviews together. The developer edits these files to tune review behavior. This is prompt tuning, not model-weight training.

Keep schema enforcement, evidence-ID validation, image authorization, source verification, and the no-tool boundary in code. Prompt edits cannot disable those checks. Untrusted content is delimited separately from developer instructions. Each phase combines shared instructions with its text, image, or final task instructions. Sharing a model does not collapse these phases.

Record provider, model, pass, effective reasoning settings, prompt version/content hash, input evidence snapshot identity, and output-schema version per review execution. Preserve records across supplements and model/prompt changes. Credentials, signed image URLs, and raw private prompts/evidence must not enter public logs. Model/configuration metadata is available to developers, not added to ordinary user flows.

## Checkpoint 2 implementation tasks

For each task: write the focused regression first, observe its failure, implement the smallest responsible change, run focused checks, and obtain scoped review. Reuse existing code and test infrastructure.

### Task 1: Finish the captured-listing handoff

**Files:** existing `src/listings/captured-job.ts`, `src/features/submission/captured-analysis.ts`, authenticated listing analysis route, `src/server/repositories/analyses.ts`, service-capture migration, and focused tests.

- [ ] Validate the existing service job through the private dashboard access boundary. Reuse actual Host/origin validation; preserve production Next.js request behavior.
- [ ] Persist captured listing/failure context atomically with the new analysis/run. Repeated explicit analysis actions may create distinct private reports; they never submit another scrape. Prevent accidental duplicate pending UI actions.
- [ ] Preserve full validated capture and typed source content with citation IDs, including equipment/price/specs/nulls, registration-year provenance, mileage units, descriptions, image references, and unverified listing/seller status. Add the bounded server-owned listing-photo preparation path using existing private uploads/capabilities.
- [ ] Verify completed capture, pending-job rejection, failed-capture fallback, unauthorized/cross-origin denial, malformed input, and no extra scraper POST.
- [ ] Run `npm test -- tests/captured-listing.test.ts tests/create-captured-analysis.test.ts` and the existing listing submission/polling regressions.

### Task 2: Make reviewer configuration developer-only

**Files:** `src/config/env.ts`, `src/insights/provider.ts`, existing API adapter, `.env.example`, worker configuration, and configuration/provider unit tests.

- [ ] Separate mandatory application configuration from optional review configuration. Share one review resolver across app/worker, including per-pass credentials/default inheritance/capability checks. Keep credential loading server-only and isolate unavailable pass settings from baseline/access.
- [ ] Test unified mode, split overrides, default inheritance, disabled review, missing credentials, unsupported image capability, and unsupported reasoning settings.
- [ ] Remove hard-coded product assumptions about Luna/model-specific names from the contract. Reuse the current API implementation as the first adapter.
- [ ] Reject any attempted user-submitted model/provider/prompt settings at API boundaries. Confirm ordinary browser bundles contain no credentials or model-control interface.
- [ ] Run focused provider/configuration tests, `npm run typecheck`, and `npm run lint`.

### Task 3: Add editable prompts and pinned execution records

**Files:** existing `src/insights/prompt.ts`, prompt files, provider types, analyses repository, and an additive execution/attempt migration. Preserve current run/job ownership and add service-role-only audit access with RLS.

- [x] Separate shared/text/image prompt content from request serialization without changing trust boundaries.
- [x] Validate a prompt edit changes the effective version/hash; editing untrusted listing content never changes the developer prompt.
- [x] Pin all effective model/provider/reasoning/prompt/schema/locale/input settings before scheduling passes. Persist per-pass execution/attempt outcomes and ownership. Reissue expiring capabilities without changing image content identity. Retain attempts; do not promise exactly-once provider billing. Reuse success only under the same execution fingerprint.
- [x] Test metadata persistence across a supplement run, a model change, and a prompt change. Keep credentials and expiring capabilities out of audit metadata.
- [x] Run relevant repository, prompt, and integration tests. Apply only pending additive migrations to an existing database.

### Task 4: Enforce the publication boundary

**Files:** provider result schemas, API adapter output handling, `src/analysis/pipeline.ts`, `assemble-report.ts`, private image-capability verification, and insight/pipeline tests.

- [ ] Require strict schema/enum/range validation and exact membership in that pass's supplied evidence/image IDs. Important/critical observations require valid supporting references.
- [ ] Reject fabricated references, external URLs/provenance, cross-analysis images, expired/forged capabilities, and model attempts to mark seller material official/confirmed.
- [ ] Resolve provenance from stored evidence. Preserve original source classes and verification status; image interpretation creates unverified observations, not confirmed vehicle defects.
- [ ] Keep output interpretation confidence distinct from source verification/report confidence. Retain code-owned verdict policy pending an explicit ownership decision.
- [ ] Test refusal, timeout, malformed output, unsupported confirmation, known-ID misuse fixtures, and embedded instructions in listing/image content. Known-ID semantic misuse belongs in evaluations as well as structural tests; do not claim code guarantees interpretation correctness.
- [ ] Run insight, image-capability, baseline, verdict, schema, and progressive-report tests.

### Task 5: Orchestrate unified/split review and supplements

**Files:** pipeline/stages, worker composition, review result merge, jobs/analyses/evidence repositories, and existing lineage/leasing/submission tests.

- [ ] Both modes perform text review and individual selected-image reviews against one snapshot, followed by final synthesis using the configured text model. Unified mode shares one model; split mode separates text/image models. Skip absent image work explicitly. Persist each image result and evidence identity.
- [ ] Use one coordinator with atomic per-pass commits and lease/run ownership checks. Save successful results during retries. Publish baseline/progress while working, but start final processing only after every scheduled pass has a durably committed validated result. Failed/expired/superseded work cannot produce a finalized AI review.
- [ ] Apply exact structured deduplication after the final barrier, retain different observations and explicit conflicts, and never convert model agreement into source corroboration. Pin and audit the final text-model execution, editable final prompt, source executions, input identity, and output. Test that no final call starts while any scheduled text/image review remains unfinished; test final-call retry and single publication.
- [ ] Preserve supplement idempotency, parent-run lineage, accepted-run evidence IDs, authoritative empty snapshots, and ownership-safe retries. Rerun affected review work using a coherent current input snapshot.
- [ ] Ensure the production worker performs no source discovery/direct registry lookups. The compatibility research stage settles as `not_checked` and does not stall completion.
- [ ] Test success in both pass orders, one-pass timeout, disabled/no-image states, crash after a pass commit, lost response, lease loss, exhausted retry, superseding supplement, and exactly one final publication after all successful pass commits. Run focused worker/pipeline tests plus `npm run test:integration`, with disposable analysis IDs and scoped leasing. Do not run the production worker against integration fixtures.

### Task 6: Finish the report journey

**Files:** checkpoint 1 dashboard/analysis action, private `/[locale]/r/[publicId]` page, manual analysis creation route/use case, report/supplement components, locale provider/request configuration, report CSS/build integration, ET/EN messages, and affected UI/E2E tests.

- [ ] Retain `/[locale]/a/[jobId]` for the captured car dashboard. Open a private progressive report through its existing access-token/cookie flow.
- [ ] Show findings/evidence, unavailable checks/review passes, seller message/copy, and the additional-information flow. There is no model selector or prompt editor.
- [ ] Connect “Continue manually” to private analysis creation without a service job. Demonstrate disabled capture with zero scraper POSTs, blocked-job and temporary-error recovery, buyer text/screenshots, seller answer plus image creating a new run at the same report URL, and private-access denial.
- [ ] Verify actual ET and EN report content, desktop/mobile layout, and model failure recovery. Verdict change is shown only when evidence warrants it.
- [ ] Run current unit/integration/static/build gates and manual browser journeys. No checkpoint 3 offline feature is added to this slice.

### Task 7: Evaluate model/prompt replacement and deliver checkpoint 2

**Files:** developer evaluation fixtures/runner, README runbook, checkpoint ledger, and review evidence.

- [ ] Evaluate normal/missing/conflicting listings, image observations, seller updates, evidence-ID semantic misuse, language quality, prompt injection, fabricated citations, and reviewer failure.
- [ ] Compare a developer-selected candidate with the current model/prompt on the same cases. Use human assessment for support/relevance/vehicle judgment; schema success alone is insufficient.
- [ ] Verify a same-provider model switch requires configuration only and a different-provider switch requires only its adapter/configuration/capability handling. No UI/domain/report rewrite.
- [ ] Record tests, model/prompt versions, current limitations, clean independent review, manual desktop/mobile results, and the tested revision. Open one checkpoint 2 PR after implementation is separately authorized and accepted.

## Later checkpoints and integrations

Checkpoint 3 retains the existing mobile checklist, explicitly saved offline copy, clear-copy behavior, and access regressions. Checkpoint 4 retains full release gates and a final real buyer journey. They reuse the same reviewer configuration and do not introduce additional AI subsystems.

Future integrations are separate work after their contracts and scope are authorized:

1. **Transpordiamet:** ordinary service/API code fetches the summary. Supply original vehicle-match/source/capture metadata to the reviewer. Do not introduce another AI summarizer.
2. **Factory manuals:** ordinary indexing/search/filtering retrieves applicable excerpts. Preserve manual version, vehicle applicability, and page/section references. No separate AI retrieval/reranking agent or embeddings model is implied by this plan. Decide the retrieval implementation when this subsystem is scoped.
3. **Paid VIN lookup:** add very late. Use an explicit purchase/request flow, a separate API adapter, and source-preserving evidence mapping. The data reviewer interprets the returned records; it cannot initiate purchases.

Factory/manual context and official records are not proof of this car's physical condition. Preserve distinctions between documentary records, seller claims, and image observations.

## Developer agents and effort

Use the [development agent policy](~/cars/docs/agent-policy.md). Keep allocation changes there; record only actual execution outcomes in this plan’s review and progress records.

## Requested review scope and acceptance

Independently review this draft against the entire existing main application in the checkpoint 2 target AND the preserved full prototype, including dirty/untracked application files. Exclude `src/auto24_service`, standalone service code/tests/docs, and any `poc` directories. The app-side Auto24 client/contract remains in scope because its handoff feeds the reviewer.

Classify findings as: contradiction within the plan, discrepancy with current target code, historical code requiring selective reuse/exclusion, or product decision still open. Cite exact plan sections and code paths/lines. Cover configuration/UI isolation, split execution/merge/failure behavior, editable prompts and provenance, supplied evidence validation, semantic limitations, verdict ownership, privacy/image capabilities, stage/job lineage, migrations, future-source scope, and checkpoint delivery.

The initial review report describes the prior draft and its exact hash; its line references must not be applied to this amended version. The accepted resolutions above address that report at planning level, not as implemented/tested fixes. Any re-review must label observed results and distinguish current code gaps from promised future work. It must not change implementation files, apply migrations, call paid services, or run live model requests. Save a separate report under `docs/superpowers/reviews/2026-09-30-data-reviewer-plan-review.md` in the root project. Do not call this draft approved merely because its code discrepancies are expected.
