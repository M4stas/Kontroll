# Data reviewer evaluation runbook

Compare two models on the same synthetic reviewer inputs, using the production reviewer and prompts. The cases do not establish ground truth.

## Run a model comparison

Declare both model IDs under the same provider in `DATA_REVIEW_CAPABILITIES`. OpenAI needs `OPENAI_API_KEY`. `--provider codex` needs `codex login`. Keep credentials and result files out of the repository.

```sh
pnpm tsx scripts/evaluate-reviewer.ts run \
  --baseline BASELINE_MODEL_ID \
  --candidate CANDIDATE_MODEL_ID \
  --output /private/tmp/reviewer-evaluation.json \
  --run
```

The command prints the number of provider requests first. It writes the result file and a `.human-review.md` sheet with both outputs side by side. Add `--fixture FIXTURE_ID` to run one case.

The script skips the image case unless `DATA_REVIEW_EVALUATION_IMAGE` is set. It must hold a valid server-issued capability for a private image in the configured Supabase storage, as JSON: `{"capability": {"version": 1, "payload": "…", "signature": "…"}}`. Use an image that matches the fixture's wheel rubric.

## Human scoring

Rate each response from 1 (poor) to 5 (strong):

- **Support.** Are claims backed by the exact evidence supplied?
- **Relevance.** Does it focus on issues useful to this buyer?
- **Vehicle judgment.** Does it reason well about the car, preserve uncertainty, and separate seller claims from verified facts?
- **Language.** Is it clear and natural in the requested language?

`schemaAccepted: true` only means the response passed the schema. Do not score `reviewer-unavailable-control`, which makes no provider request.

Save ratings as JSON, matching the fixture ID and variant from the result file:

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
    }
  ]
}
```

Then summarize them:

```sh
pnpm tsx scripts/evaluate-reviewer.ts summarize \
  --results /private/tmp/reviewer-evaluation.json \
  --scores /private/tmp/reviewer-scores.json \
  --output /private/tmp/reviewer-summary.json
```

The summary reports per-model means and paired differences for fixtures rated for both models. For a prompt comparison, run the same fixtures and models against each prompt revision, and keep the result files separate.

## Fixture contract checks

```sh
pnpm test -- tests/unit/insights/reviewer-evaluations.test.ts
```

This checks the fixtures and score summaries, not whether any model's interpretation is correct.
