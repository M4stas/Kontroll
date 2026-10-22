# S4 A: Background check in the extraction service

Status: Tasks 1 to 4 in progress. Task 5 waits for the user's recon session. Tasks 5 and 6 are not started.

Authority: [background check plan, S4 A](../plans/2026-10-22-transpordiamet-background-check.md#s4-a-background-check-in-the-extraction-service), [development agent policy](../../agent-policy.md).

## What you will see

The spec's [S4 A section](../specs/2026-10-22-transpordiamet-background-check-design.md#what-you-will-see) describes the finished checkpoint. Until Task 5 lands, every lookup a worker claims ends as `unavailable` with reason `site_changed`, because the page driver does not exist yet.
