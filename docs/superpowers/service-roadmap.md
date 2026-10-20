# Service roadmap

Planned work on the Auto24 extraction service that is not yet implemented. Service work can proceed alongside the redesign. Finished work lives in [archive](archive/README.md).

Each checkpoint ends with a change you can see in the running service. After a checkpoint, run it, follow its check steps, and then decide whether to approve the next one. The design is in the [registration reveal spec](specs/2026-10-11-auto24-registration-reveal-design.md). Main app work that follows is in the [main roadmap](roadmap.md).

| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| S1 | Registration number and VIN in the extraction result | The full registration number and VIN with their status in the extraction API docs page, and the solve record in the job | Premerge fixes reviewed; 426 offline tests passed, latest live gate failed at 3 of 10 on attempt 1. App integration stopped. See [current evidence](checkpoints/2026-10-12-registration-reveal-s1.md#premerge-fix-results). | [Plan](plans/2026-10-11-auto24-registration-reveal-s1.md), [spec](specs/2026-10-11-auto24-registration-reveal-design.md) |
| S2 | Chromium capture engine with the local CaptchaRaptor extension | C1: a Chromium job returns the same facts as Camoufox, with `engine: chromium` and `extension_loaded: true`. C2: the revealed values with `solver: extension`, and an engine benchmark | C1 and C2 built and verified offline on ARM64; C2 checks wait for you on the `x86_64` server. See [checkpoint](checkpoints/2026-10-19-chromium-engine.md). | [Spec](specs/2026-10-19-chromium-extension-engine-design.md), [plan](plans/2026-10-19-chromium-extension-engine.md) |

## S1: Registration number and VIN in the extraction result

### Before starting

- Done: rewrite the CAPTCHA and hidden-control sentences in the [Auto24 service design](archive/auto24-service/2026-09-26-auto24-extraction-service-design.md) to point to the spec.
- Create the `captcha-solver-assets` branch from the pinned upstream commit, with user approval before pushing it.
- Done: the user saved listing 4341713 from a private Firefox window (page markup before and after the reveal, a HAR log, notes) in a folder outside the repository. Test pages built from it replace real values, keys, tokens and cookies with made-up ones. Findings are in "Auto24 reveal mechanics" in the spec.

### What you will see

In the extraction API docs page (`http://localhost:8000/docs`), a submitted listing returns the full registration number and VIN with their status, and the job includes the solve record.

### How to check

1. Run `scripts/fetch-captcha-solver` and confirm it reports all four files verified.
2. Run the offline sandbox and confirm it reports no outgoing traffic.
3. Run the live sandbox and confirm PASS with only the three allowed hosts.
4. Run the benchmark with `--mode fresh saved` on a few listings and confirm PASS for `camoufox/fresh`. (`saved` is reported, not gated.)
5. Rebuild the Auto24 stack, submit a listing with hidden values in the API docs page, and compare the returned values with the listing in your own browser.
6. Submit a listing with no registration row and confirm `not_listed` and a completed job.

If step 4 fails the gate, stop and review approach A before continuing.

## S2: Chromium capture engine

C1 and C2 are built. The C1 checks are in the [checkpoint doc](checkpoints/2026-10-19-chromium-engine.md#c1-auto24-capture-on-chromium) and the C2 checks are in [its C2 section](checkpoints/2026-10-19-chromium-engine.md#c2-plan-a-reveal-and-the-engine-benchmark). The C2 benchmark is two runs on the same listings file, one per image (`camoufox/fresh` in `worker`, `chromium/fresh` and `chromium/shared` in `worker-chromium`). Replacing Plan B needs `chromium/fresh` to pass 3 runs in a row. If it fails the gate, decide between CloakBrowser and staying on Plan B.
