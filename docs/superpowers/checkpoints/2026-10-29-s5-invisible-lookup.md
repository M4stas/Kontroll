# S5: Background check on invisible_playwright

Status: Tasks 1 to 5 are implemented. Task 5 service tests pass, and the offline network check passes with no contacted hosts. The live check has not run.

Authority: [S5 plan](../plans/2026-10-29-invisible-mnt-lookup-engine.md), [development agent policy](../../agent-policy.md).

## What you will see

With `worker-invisible` running and `CHROMIUM_LOOKUPS=false`, the background check line can show "PDF ready". The lookup worker logs `background_check=fetched engine=invisible`. The Chromium worker keeps listing captures.

## What each task adds

- Task 1 makes the MNT driver work with either engine. The session chooses how to check reCAPTCHA readiness and receive the PDF.
- Task 2 adds pinned runtime and test images. Compose adds `worker-invisible` and a volume init service in profile `invisible`.
- Task 3 adds guarded invisible sessions, fresh profiles and deadline cleanup. It disables the launch IP echo call. Compose also blocks the three IP echo hosts.
- Task 4 adds a worker that claims only lookups. `CHROMIUM_LOOKUPS` defaults to `true`; setting it to `false` stops Chromium from claiming lookups.
- Task 5 adds `capture-invisible` and an offline fake MNT lookup to the network sandbox. Live listing captures reject this engine with usage and exit code 2. It also stops invisible Firefox's background calls to Mozilla and GitHub.

## Offline evidence on Mac ARM64

Counts below come from the per-task ledger and the Task 5 run.

| Check | Result |
| --- | --- |
| Tasks 1 and 2 | Ledger records clean reviews but no test counts |
| Task 3 invisible tests | 9 passed |
| Task 3 Chromium tests | 26 passed |
| Task 3 unit tests | 12 passed |
| Task 3 contract tests | 16 passed |
| Task 4 full sandbox suite | 834 passed, 5 skipped |
| Task 5 capture script and sandbox report tests | 28 passed |
| Task 5 offline network sandbox, invisible | PASS, contacted hosts: none |
| Task 5 offline network sandbox, Camoufox | PASS, contacted hosts: none |
| Task 5 invisible tests after the traffic fix | 16 passed |

## How to check

Before starting, build the images and make the netlog image available. Use the stack environment file described in [local development](../../local-development.md). The controller must obtain approval before the live lookup steps.

1. Build with `docker compose --profile invisible build worker worker-invisible`.
2. Run `scripts/network-sandbox offline --engine invisible`. It should print "offline background check: fake MNT search fetched a fake PDF" and PASS with no contacted hosts.
3. Set `CHROMIUM_LOOKUPS=false` in the stack environment file and start with `docker compose --profile invisible up -d` using that file.
4. Submit a listing you supply. Press the report button after its registration number appears.
5. Wait for "PDF ready" on the background check line. Open the PDF and check that it belongs to the listing.
6. Check `docker compose logs worker-invisible` for `background_check=fetched engine=invisible`. Check that `docker compose logs worker` has no lookup for that job.
7. Stop `worker-invisible` and request another report. After four minutes its background check should read "Unavailable" while the rest of the report finishes.
8. Remove `CHROMIUM_LOOKUPS` and recreate `worker`. Chromium should claim lookups again.

Stop here for the user's review of this checkpoint.

## Live check

The live check has not run yet.

## Known gaps

Before the traffic fix, the invisible offline check contacted 13 hosts: Mozilla telemetry, Remote Settings, push, ads and location services, the captive-portal check, Cloudflare DNS over HTTPS, and an invisible_core launch counter on GitHub. Page-hidden prefs and `network.dns.localDomains` now stop them. Release Firefox ignores a Remote Settings server override, so built-in webcompat fixes do not update. The controller will run the approved live check later and record its fetched count and median time.
