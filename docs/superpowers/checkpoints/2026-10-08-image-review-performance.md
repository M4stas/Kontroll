# Image review performance, October 8, 2026

The candidate reviews up to three images concurrently. In a small paired live
benchmark, three photos took 69.75 seconds on average with the previous
coordinator and 22.48 seconds with the candidate, a 3.10x speedup for the image
phase. The experiment ran in a separate checkout. Auto24 and the main application
were not changed or restarted.

## Service overview and selected change

The analysis worker captures an immutable review snapshot, reviews its text,
reviews each selected image through the local Codex adapter, then runs a final
assessment. Each image has a private capability, separate Codex process and
temporary directory, durable execution, and lease-bound attempt. The final
assessment validates the committed text and image execution IDs in manifest order.

Previously, every image awaited the preceding image. Local audit records contained
221 successful Luna xhigh image attempts longer than one second, with mean 32.02
seconds and median 28.80 seconds. These historical records are context, not a
paired measurement or a semantic accuracy score.

The candidate retains text-first and final-last scheduling, all selected photos,
the same image model and xhigh effort, prompt, high image detail, and 1600px copy.
It adds a pool of three image tasks, serializes immutable progress writes, and
collects results in manifest order. A fatal storage or lease error stops new
scheduling and drains started work before returning. Ordinary reviewer warnings
still let other images finish, and retries reuse their committed results.

| Alternative | Implementation and maintenance | Decision |
| --- | --- | --- |
| Three concurrent image tasks | Moderate coordinator change; 31 added and 10 removed production lines. No model behavior setting to retune. | Implemented and measured. |
| Lower image reasoning effort | Existing configuration; fewest code changes and easiest to configure. Requires semantic evaluation of missed details. | Deferred to preserve review settings. |
| Lower lossless PNG compression | One source line; easiest code change to maintain. Preparation CPU benefit remains unmeasured. | Deferred because serial model calls dominate the observed mechanism. |

## Live comparison

Baseline commit: `2710cd03a4a0afaf3f87d3e743a13d0ea4262a47`.
The user explicitly approved 12 image-only calls on the same three stored car
photos. Both variants used the original pinned Codex `gpt-6-luna`, `xhigh`, and
prompt hash. Runs alternated baseline/candidate then candidate/baseline to reduce
ordering bias. All 12 image calls completed with no warnings.

| Round | Sequential baseline | Candidate, concurrency 3 | Speedup |
| --- | ---: | ---: | ---: |
| 1 | 59.142 s | 20.219 s | 2.93x |
| 2 | 80.353 s | 24.739 s | 3.25x |
| Mean | 69.747 s | 22.479 s | 3.10x |

The candidate reduced measured image-phase wall time by 67.77%. This is two rounds
on three photos, not a production throughput guarantee. The benchmark uses real
private-image hash verification, signed access, image preparation, and model
calls. Text and final passes are local no-ops, and repository writes are in
memory. It does not measure whole-report latency, live database commit overhead,
or establish equal semantic accuracy. Returned observations varied across calls.
Keeping inputs and model settings unchanged avoids an intentional quality
tradeoff but does not prove output equivalence.

The cap applies per coordinator. Multiple application workers multiply account
concurrency. One-photo reviews have no scheduling speedup. Provider load and
rate limits can affect the result.

## Verification

- Baseline unit suite: 557 passed. Candidate: 561 passed across 54 files.
- New coordinator tests failed under serial scheduling, then passed after the
  change. Focused suite: 22 passed.
- Full database integration suite: 87 passed across 8 files. The four-image
  regression gates completions out of order and checks the three-task bound,
  real durable commits, manifest order, monotonic stored progress, and one final
  publication. The durable pipeline file passed 26 tests.
- HTTP e2e used the duplicate app on port 3040 and a new Supabase project on ports
  55420–55429. Four synthetic images passed through submission, private storage,
  worker stages, progress polling, and final publication. Observed three running
  images, completion counts 0, 3, 4, a complete final report, and HTTP 401 without
  the report cookie. The controlled reviewer made no external model calls.
- Browser verification displayed `Analysis complete`, `Review complete`, and
  `Photos: 4 of 4 reviewed` on the resulting private report.
- Typecheck, repository lint, and diff whitespace checks passed.
- Independent subagent review of production code, tests, and benchmark was clean.

An initial HTTP harness expected 201 for image upload; the endpoint correctly
returned 202. Correcting that assertion left one queued synthetic fixture, which
caused four queue-isolation failures in the first broad integration run. Removing
only that disposable fixture and rerunning produced the clean 87-test result.
The test app and disposable stack were stopped after verification.

Performance investigation used GPT-6.1 Sol xhigh, implementation used Sol medium,
and independent concurrency review and database e2e used Sol high. These are
historical executions for this chat, not new agent defaults. No Astra or max was
used by these agents, and the protected policy files were unchanged.

## Reproduce

Replay makes no provider requests and compares fixed delays on 15 images:

```sh
npx tsx scripts/benchmark-image-review.ts --images 15 --rounds 5 \
  --output /tmp/image-review-replay.json
```

The replay averaged about 1.520 seconds sequentially and 0.509 seconds with the
candidate. It proves scheduling overlap only.

For a live comparison, choose a private snapshot with at least three accepted
images pinned to the production Codex Luna xhigh image reviewer. Use a private
environment file containing `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `ANALYSIS_COOKIE_SECRET`, plus the configured
Codex command if needed. The explicit flags below make 12 model calls and send
the selected photos to the configured Codex reviewer. Obtain approval for those
photos and destination before running.

```sh
npx tsx scripts/benchmark-image-review.ts --live --run \
  --snapshot SNAPSHOT_UUID --env-file /private/path/worker.env \
  --images 3 --rounds 2 --output /private/path/image-review-live.json
```

Output files require a new path and are written with mode 0600. Live output
includes model observations; keep it private. The committed
[sanitized evidence](image-review-performance.json) contains only settings,
timings, counts, and controlled HTTP results. It contains no photos, image IDs,
storage keys, URLs, credentials, capabilities, or observation text.
