"""Check fresh extraction jobs. Print counts only, never listing or identity data."""

import json
import os
import time
from collections import Counter
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

MINIMUM_RATE = 0.8
TIMEOUT_SECONDS = 240


def outcome(job):
    if job.get("status") == "failed":
        return "capture_failed"
    if job.get("status") != "completed":
        return None
    registration = (job.get("listing") or {}).get("registration") or {}
    statuses = [registration.get(f"{field}_status") for field in ("reg_number", "vin")]
    if "pending" in statuses:
        return None
    if "unavailable" in statuses:
        return "reveal_failed"
    return "revealed" if "revealed" in statuses else "no_reveal"


def passed(results):
    return bool(results) and results.count("revealed") / len(results) >= MINIMUM_RATE


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # The API key must never follow a redirect to another service.
        return None


def sample(base, key, url):
    opener = build_opener(NoRedirect)
    deadline = time.monotonic() + TIMEOUT_SECONDS

    def request(path, body=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        req = Request(
            base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"X-API-Key": key, "Content-Type": "application/json"},
        )
        with opener.open(req, timeout=min(20, remaining)) as response:
            return json.load(response)

    # POST always creates a new job. Never reuse a previous day's completed job.
    job = request("/v1/jobs", {"url": url})
    job_id = str(UUID(job["job_id"]))
    while True:
        result = outcome(job)
        if result is not None:
            return result
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "timeout"
        time.sleep(min(3, remaining))
        try:
            job = request(f"/v1/jobs/{job_id}")
        except HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise
        except (OSError, HTTPException, ValueError):
            pass


def main():
    try:
        base = os.environ["REVEAL_CHECK_API_URL"].rstrip("/")
        key = os.environ["REVEAL_CHECK_API_KEY"]
        urls = [line.strip() for line in os.environ["REVEAL_CHECK_LISTINGS"].splitlines()
                if line.strip()]
        endpoint = urlsplit(base)
        if (endpoint.scheme != "https" or not endpoint.hostname or endpoint.username
                or endpoint.password or endpoint.query or endpoint.fragment or not key):
            raise ValueError
        if not 3 <= len(urls) <= 5 or len(set(urls)) != len(urls):
            raise ValueError
    except (KeyError, ValueError):
        print("Reveal check configuration missing or invalid. See docs/daily-reveal-check.md.")
        return 2

    results = []
    for url in urls:
        try:
            result = sample(base, key, url)
        except TimeoutError:
            result = "timeout"
        except Exception:
            # Exceptions and HTTP bodies can contain URLs, keys or vehicle data.
            result = "service_error"
        results.append(result)
    success = passed(results)
    report = (f"Daily reveal check: {'PASS' if success else 'FAIL'}\n"
              f"Revealed {results.count('revealed')}/{len(results)}; required {MINIMUM_RATE:.0%}.\n"
              f"Outcomes: {json.dumps(dict(Counter(results)), sort_keys=True)}\n")
    print(report)
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
