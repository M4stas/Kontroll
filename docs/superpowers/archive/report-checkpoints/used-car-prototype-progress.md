# Kontroll checkpoint progress

> Historical checkpoint 1 ledger. Preserve its demo and review evidence. Its earlier “Resume next” instructions are superseded by the September 30 data reviewer plan; current delivery evidence is recorded in [checkpoint 2](checkpoint-2-analysis.md).

Updated 2026-09-30. Execution plan: [used-car analysis prototype](../2026-09-12/2026-09-12-used-car-analysis-prototype.md#checkpoints-and-real-demos).

## Starting point

- Branch `codex/used-car-prototype`, HEAD `89b99b5`.
- [PR #1](https://github.com/M4stas/kontroll/pull/1) was closed on 2026-09-28 at the user's request. It bundled analysis/verdict/research/Luna, seller supplements, and offline viewing beyond Checkpoint 1. The local and remote prototype branches and all files remain preserved. Final review and release acceptance remain pending.
- Tasks 1-13 have implementation and historical scoped review records. Preserve `.superpowers/sdd/2026-09-12-used-car-analysis-prototype/`, including its progress, handoff, review reports, and demo screenshots.
- September 28 checks on the working tree: 283 unit tests pass, lint passes, and `git diff --check` passes. Typecheck fails because `src/listings/auto24.ts` references `cheerio.Element`. The unit rerun passed outside the sandbox after `tsx` hit a local-pipe permission restriction.
- Last recorded full gate at `d1a7ed9`: 272 unit, 55 integration, and 4 seeded-browser tests passed, plus typecheck, lint, and build. Those historical results do not cover subsequent changes or establish a live worker/browser journey.
- Existing work to preserve: modified `package.json`, `package-lock.json`, `src/listings/auto24.ts`, and `tests/unit/listings/auto24.test.ts`; new `src/listings/auto24-browser.ts` and its test. The unrelated `.DS_Store` file remains outside this work. This plan update does not fix, commit, or discard those changes.
- Historical elapsed time and added LOC are unknown. Begin accounting with the next repair slice, keeping its baseline diff.

## Checkpoint status

| Checkpoint | Current status | Remaining acceptance |
|---|---|---|
| 1. Auto24 URL to car dashboard | Implementation and verification complete; PR #5 open | User reviews the real demo and the Checkpoint 1 PR. Checkpoint 2 waits for demo acceptance and merge. |
| 2. Analysis report and follow-up information | Existing analysis implemented; service-result integration and current demos pending | Feed captured listing into existing analysis. Show baseline, fallback recovery, same-report seller/image update, actual ET/EN content, copied message, private-access denial, and stable provenance without AI dependency. |
| 3. Take the report to a viewing | Historical scoped acceptance recorded; current regression demo pending | Show current mobile/offline reload, checklist persistence, clear-copy behavior, and desktop/mobile privacy checks. |
| 4. Reviewed release candidate | Open | Final full gate, clean independent review, manual desktop/mobile E2E, separate release-checkpoint PR, final real demo. |

No checkpoint was retroactively accepted by this documentation update. Reuse valid evidence, but label its revision and distinguish seeded or controlled cases from current real demos. Online source discovery, direct background lookups, PDF interpretation, price estimates, and paid reports remain outside the agreed scope.

## Resume next

1. Preserve the current prototype worktree and its edits. Fetch `origin/main` and create an isolated `codex/` checkpoint branch. Selectively reuse only the files needed for the API/dashboard; leave later work in the preserved prototype branch. Record the slice's estimate, source commits, baseline diff, and active start time before editing.
2. Reuse the service's `POST /v1/jobs` and `GET /v1/jobs/{job_id}` contract through a server-only client. Persist the submission/job association and preserve the existing private access boundary. Fix the known compile error only as needed for a clean build.
3. Add visible submission, queued, running, slow, disconnected, completed, and failed UI states. Render the returned car information independently of the analysis worker or Luna.
4. Start the actual scraping service and app using their runbooks. Preserve existing database data. Verify the real URL-to-dashboard flow on desktop/mobile, plus controlled delays and error recovery.
5. Obtain scoped review, record sanitized API/dashboard evidence, show the actual demo, and open a Checkpoint 1-only PR. Start Checkpoint 2 after the user reviews the demo and this PR merges.

## Revised Checkpoint 1 scope

The user explicitly requested the scraping service API connection. Checkpoint 1 finishes when entering an Auto24 URL opens an understandable dashboard and the car information appears when the API returns it. Display honest activity, elapsed wait, and the last successful status check. Use plain recovery messages for delays and errors; do not claim a frozen or unreachable service is still processing. Analysis reports, verdicts, seller follow-up, and pasted/screenshot fallback remain in Checkpoint 2. Keep the existing code and historical task progress.

## Source scope amendment, 2026-09-28

- Remove online searching for reputable sources from the delivered prototype. This includes AI web search and active background/registry research adapters. The existing Auto24 scraping API remains in Checkpoint 1.
- Official vehicle background data will come from the user's separate Maanteeamet service after its contract and integration are authorized. The prototype does not build that service now. A factory repair-manual database is a possible later project.
- Official checks remain `not_checked` until applicable service data exists. Optional AI uses supplied listing, seller/buyer, and image evidence; it cannot create verified facts from model memory or invented citations.
- Preserve the old research/provider/cache code, tests, schema, and historical data. The archived full-prototype branch currently still has web search in `src/insights/luna.ts` and a direct NHTSA provider in `scripts/worker.ts`. This documentation update does not alter that runtime. Exclude those capabilities when selectively delivering checkpoint branches.
- In Checkpoint 2, verify no AI search tools, invented external citations, or outbound background lookups; confirm `not_checked` source coverage does not stall the report. Do not add a new service contract or manual retrieval system before the user supplies one.

## PR audit and checkpoint policy

- Only PR #1 was open during the audit; it has been closed without branch deletion.
- [PR #2](https://github.com/M4stas/kontroll/pull/2), [PR #3](https://github.com/M4stas/kontroll/pull/3), and [PR #4](https://github.com/M4stas/kontroll/pull/4) are already merged. They supply the existing scraping service used by Checkpoint 1 and were left in place.
- No source files, branches, commits, worktrees, or database data were removed or reverted.
- Future main-app PRs contain one checkpoint each. Keep one open at a time. Verify the complete diff against its base before opening it; preserve later files in the prototype worktree rather than including or deleting them.
- PR #1 is a historical record of preserved work, not the delivery vehicle for the new checkpoint sequence.

## Evidence entry template

Append one entry per repair slice and checkpoint. Replace all template fields with observed results; do not mark acceptance from a planned demo.

- Checkpoint and repair slice:
- Status: in progress, blocked, or accepted. Describe any blocking condition without implying automatic task cancellation.
- Tested commit and dirty-file list; baseline diff for existing edits:
- Scope of changes and reviewer scope:
- Estimate, active start/end in UTC, pauses, and actual active time:
- Added nonblank source/test/config LOC and deleted LOC; excluded inherited changes:
- Exact startup, worker, and verification commands; exit codes and test totals:
- Listing URL and capture result: live success, live blocked/unavailable, or controlled input:
- Submission public ID, service job ID, and later analysis run IDs; omit token fragments and access credentials:
- Checkpoint 1 status transitions, poll timestamps, and returned listing versus displayed fields; later report findings, actions, verdict, and confidence:
- Source coverage and limitations, including AI enabled/disabled and unread PDFs:
- Desktop/mobile manual results and screenshots or recording paths:
- Redacted representative service response or report JSON path:
- Separate reviewer outcome and addressed findings:
- Evidence shown to the user and what they can try in the actual app:
- Overrun notices and revised estimates:
- Remaining issues and next checkpoint:

Store sanitized evidence under `docs/superpowers/checkpoints/used-car-prototype/`. Do not commit private report links, tokens, cookies, signed upload URLs, API keys, or unsanitized personal information. Open the authenticated local demo in the user's browser panel when possible; shared notes use public IDs and redacted output.

## Development-agent policy, 2026-09-29

Future assignments follow the [development agent policy](../../../agent-policy.md). The checkpoint entries below are historical execution evidence, not allocation instructions.

## Checkpoint 1 execution, 2026-09-29

- Isolated branch `codex/checkpoint-1-dashboard`, base `82326d3`; preserved full-prototype checkout and its edits remain intact. No Python service source changes.
- Foundation commit `1e9c16e`: server-only service client, validated listing/job contract, same-origin submission, per-job signed HttpOnly access, private noncached reads, bounded service requests. Service stores jobs durably; a 24-hour per-job cookie supports refresh/resume in the submitting browser without a new app database. Dashboard URL alone grants no access.
- Foundation verification: 18 focused tests, typecheck, lint, production build, and diff check passed. Independent Sol medium review found two boundary issues (HTTP photo acceptance and body-timeout classification); fixes and renewed review remain pending.
- Actual service smoke: public listing `https://www.auto24.ee/soidukid/4344096`, job `5bf0f4a4-69e0-44dc-a039-860abdc0cb92`, captured `2026-09-29T05:46:50.296820Z`; Skoda Enyaq 195kW, year2022, EUR41500,46800km,19 photo references. This is service proof only; dashboard live/manual proof remains pending.
- Active start `2026-09-29 05:43 UTC`; original estimate120–240 active minutes and150–450 nonblank source/test/config LOC. Size revised600–1000 after full contract and lifecycle requirements, user notified; docs/fixtures/lock/generated files excluded. Foundation338 LOC.
- Assignments: Sol medium foundation; Luna max dashboard; independent Sol medium API review and later manual desktop/mobile test. One source implementer edits at a time. Coordinator final whole-branch review capped at Astra high.
- Remaining: dashboard implementation, boundary fixes, meaningful lifecycle tests, live desktop/mobile demo, clean independent review, Checkpoint1-only PR. Checkpoint2 remains deferred.

## Checkpoint 1 final verification

- Baseline source revision `c2edbfefea939dec268ef08c3a9f3967edf08cb9`, base `82326d3`. The reviewed/tested 2026-09-30 app-only repair is commit `c59f45d`; the preserved full-prototype and Python service remain untouched.
- Changes: minimal Next.js ET/EN submission/private dashboard, direct service-result display, bounded submission/polling, honest status/recovery, complete captured fields/photos. No analysis/research/background lookup/AI/upload/offline flow. Python service unchanged.
- No new app database: durable service jobs and signed per-job 24h HttpOnly cookies support refresh/resume. Cookie clearing/expiry/key rotation loses access; URL alone cannot grant access.
- `npm ci --no-audit --no-fund` passed for the baseline. On the 2026-09-30 repaired source, `npm test`55/55 across8files, `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` passed. The earlier browser credential scan found no service key or signing secret in23JavaScript files.
- Independent Sol medium API review found HTTP photo acceptance and body-timeout classification; both corrected in `df9762d`, then reviewed clean. Independent UI integration review at `df9762d` clean. Actual production manual testing uncovered Next Request Proxy reconstruction and internal-host Origin comparison errors; four failing regressions proved the causes, `c2edbfe` fixed both,45tests and renewed HTTP/browser journeys passed. Independent Sol reviewed that two-route fix clean. Coordinator whole-branch review clean.
- Live dashboard job `e572dc2a-c030-481e-973b-7b4a106b6ae9`: submitted07:02:52.938965UTC, completed07:03:00.049498UTC. Actual queued state shown, then Skoda Enyaq195kW,2022,EUR41500,46800km,19photos automatically rendered. Earlier completed job recovered on refresh without another submission. Sanitized JSON and actual desktop/mobile screenshots in `docs/superpowers/checkpoints/used-car-prototype/`; timed screenshot sequence explicitly is not continuous video. Real fast scrape did not expose every running/delay/error state, so those are separately labeled controlled evidence.
- Final measured nonblank source/test/config additions2728, deletions0 against base; excludes docs, fixture payloads, generated files and lockfile. Original150–450estimate was too low; forecasts600–1000,1200–1800 and2600–3200 were communicated as scope/validation size became visible. Scope stayed Checkpoint1.
- Active accounting: first execution05:43–07:05UTC, approximately82minutes. No activity during the interrupted07:05–11:56UTC interval; resumed11:56UTC. Final end/time and manual outcome recorded below after verification. Original estimate120–240active minutes.
- Agents: Sol medium foundation/debugging; Luna max dashboard implementation; separate Sol medium API review and manual desktop/mobile testing; coordinator most-capable final review, Astra cappedhigh. One source writer at a time.
- Checkpoint2 starts only after user demo review and this checkpoint PR merges.

## Checkpoint 1 repair and rerun, 2026-09-30

- Independent GPT-6.1 Sol high review found that a fresh authorized tab lost the submitted URL until completion. GPT-6.1 Sol low repaired this within the Next app: the canonical URL is bound to the job ID and expiry in the existing signed HttpOnly cookie. The server passes it into the initial dashboard and authorized status response. Old cookies remain valid without a recoverable submitted URL. Tampered cookies cannot disclose it. A second high-effort independent review found no remaining actionable issue.
- The 55-test suite, lint, typecheck, production build, and diff check passed after the repair. No Python service source or tests changed.
- Live production browser journey on the repaired source: job `7ea4f2ad-bfcf-48fc-ba7f-79fff1a633b8` showed the submitted Auto24 address in a newly opened authorized tab while running, then automatically displayed Skoda Enyaq195kW,2022,EUR41500,46800km. The mobile390×844 view had scrollWidth390 and no visible clipping in the status, source link, or first facts.
- Controlled local fixture browser observations: invalid URL stayed in the input with inline guidance; access-blocked listing showed a terminal explanation and source link; service authentication failure showed source and `Check again` on the same job; malformed service response showed a recoverable error and source; authorized missing job showed the missing-job explanation and source. These are controlled failures, not real Auto24 capture results.
- Slow deadline/resume and hidden-tab return remain under manual check. The existing MP4 is a timed screenshot sequence, not a continuous recording. QuickTime screen recording was unavailable to the current computer-use session. Do not mark the recording requirement complete.
- User latency correction: successful active polling now waits1second after each completed request. GPT-6 Luna max implemented the narrow constant/test change; GPT-6.1 Sol medium reviewed it clean. Sequential requests, transient-error backoff, visibility pause, terminal stop, and deadline behavior remain covered by the passing polling tests. Full app suite55/55, lint, typecheck, and build passed.
- Final polling browser check: controlled job `controlled_6` moved from queued to completed; the temporary fixture recorded successful checks at22:53:49.563,22:53:50.580,22:53:51.594,22:53:52.609UTC, intervals1.014–1.017seconds. Live job `bd23c876-2796-4619-8de3-8a8160c213c1` completed automatically. Mobile DOM measured390×844 with scrollWidth390. This verifies the affected timing journey; outstanding recording and hidden-tab manual evidence still keep full checkpoint acceptance open.

## Checkpoint 1 evidence closure, 2026-09-30

- Source remains `c59f45d`; independent GPT-6.1 Sol medium final review at `0664e02` returned clean. Existing 55/55 tests, lint, typecheck, build, and desktop/mobile results still apply; this closure changes evidence only.
- Controlled deadline job `controlled_1`: submitted2026-09-29T23:03:51.390Z, last automatic read23:06:51.208Z. Dashboard visibly paused at the three-minute deadline. `Check again` completed the same job at23:07:28.058Z with the source retained.
- Controlled authentication-error job `controlled_2` and malformed-response job `controlled_3` both recovered through `Check again` on their existing IDs. Across these and the visibility case, exactly four submissions were created; recovery did not resubmit.
- Actual Brave hidden-tab case `controlled_4`: last visible read23:06:44.275Z; no reads while hidden; first read on return23:07:39.784Z completed the same job. The55.509-second gap verifies actual tab visibility behavior.
- User supplied a continuous39.68-second Brave recording at02:20:31 Tallinn on2026-09-30. It shows the real port3000 app, Auto24 URL4344096, submission, running wait, and automatic Skoda Enyaq195kW completion on job `9dcbe4b1-fa6d-4513-acda-95362027538f`. Visible facts:2022, EUR41500,46800km,195kW; the recording then scrolls through seller and technical information. Photos are covered by the existing separate desktop/mobile evidence. A video-only copy is `used-car-prototype/checkpoint-1-live-continuous.mp4`; the user's original remains untouched.
- Earlier user video02:18:21 showed port3001 controlled data and is not real service evidence. It was superseded by the02:20:31 recording.
- Measured recovery/visibility proof interval23:03:51–23:07:40UTC was about four minutes. Total historical active time remains incomplete; no unrecorded time is estimated here.
- [PR #5](https://github.com/M4stas/kontroll/pull/5) contains only Checkpoint1. All implementation verification and recording gates are met. User demo acceptance and merge remain prerequisites for Checkpoint2.
