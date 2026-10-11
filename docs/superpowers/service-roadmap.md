# Service roadmap

Planned work on the Auto24 extraction service that is not yet implemented. Service work can proceed alongside the redesign. Finished work lives in [archive](archive/README.md).

Each checkpoint ends with a change you can see in the running service. After a checkpoint, run it, follow its check steps, and then decide whether to approve the next one. The design is in the [registration reveal spec](specs/2026-10-11-auto24-registration-reveal-design.md). Main app work that follows is in the [main roadmap](roadmap.md).

| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| S1 | Registration number and VIN in the extraction result | The full registration number and VIN with their status in the extraction API docs page, and the solve record in the job | Planned, approved for implementation | [Plan](plans/2026-10-11-auto24-registration-reveal-s1.md), [spec](specs/2026-10-11-auto24-registration-reveal-design.md) |

## S1: Registration number and VIN in the extraction result

### Before starting

- Rewrite the CAPTCHA and hidden-control sentences in the [Auto24 service design](archive/auto24-service/2026-09-26-auto24-extraction-service-design.md) to point to the spec.
- Create the `captcha-solver-assets` branch from the pinned upstream commit, with user approval before pushing it.
- Done: the user saved listing 4341713 from a private Firefox window (page markup before and after the reveal, a HAR log, notes) in a folder outside the repository. Test pages built from it replace real values, keys, tokens and cookies with made-up ones. Findings are in "Auto24 reveal mechanics" in the spec.

### What you will see

In the extraction API docs page (`http://localhost:8000/docs`), a submitted listing returns the full registration number and VIN with their status, and the job includes the solve record.

### How to check

1. Run `scripts/fetch-captcha-solver` and confirm it reports all four files verified.
2. Run the offline sandbox and confirm it reports no outgoing traffic.
3. Run the live sandbox and confirm PASS with only the three allowed hosts.
4. Run the benchmark with `--mode both` on a few listings and confirm PASS for both modes.
5. Rebuild the Auto24 stack, submit a listing with hidden values in the API docs page, and compare the returned values with the listing in your own browser.
6. Submit a listing with no registration row and confirm `not_listed` and a completed job.

If step 4 fails the gate, stop and review approach A before continuing.
