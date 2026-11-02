# Daily reveal check

The `Daily reveal check` Actions workflow runs at 06:17 UTC on the default
branch and can also be started manually. GitHub may delay scheduled runs.
It submits three to five fresh jobs to the deployed extraction API, waits up to
240 seconds per job for registration to settle, and requires an 80% reveal rate.
Five listings allow one failure. Three listings require all three to pass.

Configure these repository settings before enabling the check:

- Secret `REVEAL_CHECK_API_URL`: the reachable HTTPS extraction service URL.
- Secret `REVEAL_CHECK_API_KEY`: its public API key.
- Secret `REVEAL_CHECK_LISTINGS`: three to five distinct active Auto24 listing
  URLs, one per line. Choose listings with a hidden registration number or VIN.

All three are secrets so that Actions masks their values in run logs.

Missing settings or a listing count outside three to five distinct URLs fail the
run before any job starts. The API alone decides whether a listing URL is valid.
A rejected or failed submit, failed capture, expired listing, timeout, or
unavailable reveal counts against the rate. The check submits each job once. It
retries polls that fail with HTTP 429, HTTP 5xx, a network error or an unreadable
response until the job's 240 seconds run out, then counts a timeout. Any other
HTTP error ends that sample as a service error.
A listing with only fully visible or absent identities also counts as a failure
because it does not exercise the solver. Replace expired or changed listings
when needed.
The check never starts a model review or a Transpordiamet background check.

Results appear in the Actions job summary as counts only. No response bodies,
service or listing URLs, registration values, VINs, cookies or images are saved.
For alerts, subscribe to this workflow's failures in GitHub Actions notification
settings. This workflow creates no issues and sends no chat messages.

The check uses the deployed worker, so it measures that deployment rather than
building the current repository revision. The existing PR live-check gate and
manual benchmark remain separate checks. Compare daily summaries in Actions
for history. This is a fixed minimum rate, not a statistical change detector.

For offline verification, run `tests/test_daily_reveal_check.py` in an isolated
Python test container with networking disabled. The tests require no service
credential. A live run needs the configured endpoint and active listing set.
