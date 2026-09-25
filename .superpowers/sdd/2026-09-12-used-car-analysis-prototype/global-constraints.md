# Global constraints

- The application and worker are TypeScript-only.
- The prototype has no signup or account requirement.
- The primary listing input is an Auto24 URL; inaccessible content falls back to pasted text and screenshots.
- Results appear progressively and a full run may take two to four minutes.
- Verdict values are `worth_viewing`, `proceed_cautiously`, and `likely_skip`; confidence values are `low`, `moderate`, and `high`.
- Seller, buyer, listing, and uploaded claims remain unverified until corroborated.
- An unavailable source is `not_checked`, never a clean result.
- Luna uses high reasoning through a configured model ID and never blocks the deterministic baseline.
- Estonian and English interfaces ship together.
- Reports and uploads are private; secret access tokens are stored only as hashes.
- The Auto24 price estimate and paid report are excluded.
- CAPTCHA solving and access-control bypasses are excluded.
- No decorative car illustration is used.
- The report uses the approved dark inspection-sheet palette and customized shadcn/ui primitives.
- Production work is complete only after task-relevant tests pass, a separate subagent review is clean, manual desktop and mobile E2E testing is clean, and a pull request exists.
