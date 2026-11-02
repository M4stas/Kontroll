# Daily reveal check

The `Daily reveal check` Actions workflow runs at 06:17 UTC on the default
branch and can also be started manually. GitHub may delay scheduled runs.
It submits three to five fresh jobs to the deployed extraction API, waits up to
240 seconds per job for registration to settle, and requires an 80% reveal rate.
Five listings allow one failure. Three listings require all three to pass.

Configure these repository settings before enabling the check:

- Variable `REVEAL_CHECK_API_URL`: the reachable HTTPS extraction service URL.
- Secret `REVEAL_CHECK_API_KEY`: its public API key.
- Variable `REVEAL_CHECK_LISTINGS`: three to five distinct active Auto24 listing
  URLs, one per line. Choose listings with a hidden registration number or VIN.
- Optional variable `REVEAL_CHECK_MIN_RATE`: a rate above zero and at most one.
  The default is `0.8`.

Missing settings fail the run. An unavailable service, failed capture, expired
listing, timeout, or unavailable reveal counts against the rate. A listing with
only fully visible or absent identities also counts as a failure because it
does not exercise the solver. Replace expired or changed listings when needed.
The check never starts a model review or a Transpordiamet background check.

Results appear in the Actions job summary and logs as counts only. No response
bodies, listing URLs, registration values, VINs, cookies or images are saved.
For alerts, subscribe to this workflow's failures in GitHub Actions notification
settings. This workflow creates no issues and sends no chat messages.

The check uses the deployed worker, so it measures that deployment rather than
building the current repository revision. The existing PR live-check gate and
manual benchmark remain separate checks. Compare daily summaries in Actions
for history. This is a fixed minimum rate, not a statistical change detector.

For offline verification, run `tests/test_daily_reveal_check.py` in an isolated
Python test container with networking disabled. The tests require no service
credential. A live run needs the configured endpoint and active listing set.
