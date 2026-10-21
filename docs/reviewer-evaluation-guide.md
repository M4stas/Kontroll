# Data reviewer evaluation runbook

These synthetic cases help a developer compare one configured model against another on the same reviewer inputs. They do not establish ground truth. Live outputs and their semantic review must be recorded separately from fixture contract checks.

The runner imports the production `createDataReviewer` factory and the same prompt composition used by the application. It forces unified mode so the baseline and candidate use one provider and model for each pass; only their model IDs differ during a model comparison. Both models must be declared in `DATA_REVIEW_CAPABILITIES` with text, structured-output, image, and reasoning capabilities supported by the configured settings. The adapters support OpenAI and local Codex. The script requires different baseline and candidate IDs and an explicit `--run` flag before making any provider calls.

The fixture set covers:

- Complete English listing and missing listing capture.
- Conflicting listing and seller mileage claims.
- One selected image review.
- A seller repair-history update.
- A valid evidence ID attached to a semantically unsupported conclusion.
- Estonian output language quality, alongside the English cases.
- Instruction-like prompt injection inside listing content.
- A request to cite a report that was not supplied.
- A forced unavailable configuration control that makes no provider request.

## Run a model comparison

Set `DATA_REVIEW_CAPABILITIES` and any supported reasoning setting in the local process environment. OpenAI requires `OPENAI_API_KEY`. For `--provider codex`, sign in with `codex login` and optionally set `DATA_REVIEW_CODEX_COMMAND` to the executable path; a separate API key is unnecessary. Do not put credentials, signed image capabilities, or generated result files in the repository. The capability table must declare both model IDs under the same provider. The runner checks configuration for text, image, and final passes before making the first request.

```sh
pnpm tsx scripts/evaluate-reviewer.ts run \
  --baseline BASELINE_MODEL_ID \
  --candidate CANDIDATE_MODEL_ID \
  --output /private/tmp/reviewer-evaluation.json \
  --run
```

The command reports the number of provider requests before starting. The output file records the fixture, model, locale, pass, prompt hash, elapsed time, schema-validation status, and returned observations. It does not save the input image capability. A companion `.human-review.md` file presents baseline and candidate outputs side by side with the fixture rubric and blank rating cells.

The image case uses a placeholder in the fixture file. To run it, set `DATA_REVIEW_EVALUATION_IMAGE` to a JSON object containing a currently valid server-issued capability, for example `{"capability": {"version": 1, "payload": "…", "signature": "…"}}`. The capability must refer to a private reference image in the configured Supabase storage origin. The runner checks its signature and expiry locally, adapts the fixture's analysis/evidence IDs to that capability, and never writes the capability to the result. Without it, the image case is recorded as skipped. Use an image that matches the fixture's wheel-observation rubric.

The `reviewer-unavailable-control` case supplies an unavailable pass pin locally. It exercises the adapter's no-call failure result; it does not simulate a provider outage or verify user-facing failure recovery. It is excluded from model-quality scoring.

## Human scoring

Review the generated side-by-side sheet. Rate each baseline and candidate response from 1 (poor) to 5 (strong) on four separate questions:

- **Support:** Are claims backed by the exact evidence supplied?
- **Relevance:** Does the response focus on useful issues for this buyer and the case?
- **Vehicle judgment:** Does it reason appropriately about the car, preserve uncertainty, and distinguish seller claims from verified facts?
- **Language:** Is the response clear and natural in the requested language?

A `schemaAccepted: true` value means only that the response passed the structural schema. It must not be treated as evidence that the response is supported or semantically correct. Do not score the unavailable control as model quality. Use the fixture rubric to guide judgment and record notes for any ambiguous case.

Save human ratings separately as JSON, matching the fixture ID and variant from the result file:

```json
{
  "scores": [
    {
      "fixtureId": "normal-listing-en",
      "variant": "baseline",
      "support": 4,
      "relevance": 4,
      "vehicleJudgment": 3,
      "language": 5,
      "reviewer": "initials",
      "notes": "Preserved seller attribution; missed one useful follow-up."
    },
    {
      "fixtureId": "normal-listing-en",
      "variant": "candidate",
      "support": 5,
      "relevance": 4,
      "vehicleJudgment": 5,
      "language": 5
    }
  ]
}
```

Summarize only those explicit human ratings:

```sh
pnpm tsx scripts/evaluate-reviewer.ts summarize \
  --results /private/tmp/reviewer-evaluation.json \
  --scores /private/tmp/reviewer-scores.json \
  --output /private/tmp/reviewer-summary.json
```

The summary reports per-model means and paired candidate-minus-baseline differences for fixtures rated for both models. It does not infer a quality score from API success, warning count, or schema acceptance. For a prompt comparison, run the same fixture set and both model IDs against each prompt revision, keep result files separate, and compare their recorded prompt hashes and human ratings.

## Fixture contract checks

The focused test checks that every case fits the current provider-independent `ReviewInput` schema, that the planned categories are represented, and that human-score summaries are bounded and paired by fixture. It does not assert that any model interpretation is correct.

```sh
pnpm test -- tests/unit/insights/reviewer-evaluations.test.ts
```

To run one case without repeating the full comparison, add `--fixture FIXTURE_ID`. The checkpoint results are recorded in `checkpoint-2/reviewer-comparison.json` and `checkpoint-2/image-comparison.json`. The image input was a labeled synthetic wheel illustration; this tests private image delivery and uncertainty, not damage detection on real vehicle photographs.
