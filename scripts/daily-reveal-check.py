"""Check fresh extraction jobs. Print counts only, never listing or identity data."""

import json
import math
import os
import time
from collections import Counter
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID


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


def passed(results, minimum):
    return bool(results) and results.count("revealed") / len(results) >= minimum


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # The API key must never follow a redirect to another service.
        return None


def sample(base, key, url, timeout):
    opener = build_opener(NoRedirect)
    deadline = time.monotonic() + timeout

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
        job = request(f"/v1/jobs/{job_id}")


def main():
    try:
        base = os.environ["REVEAL_CHECK_API_URL"].rstrip("/")
        key = os.environ["REVEAL_CHECK_API_KEY"]
        urls = [line.strip() for line in os.environ["REVEAL_CHECK_LISTINGS"].splitlines()
                if line.strip()]
        minimum = float(os.environ.get("REVEAL_CHECK_MIN_RATE", "0.8"))
        timeout = float(os.environ.get("REVEAL_CHECK_TIMEOUT_SECONDS", "240"))
        endpoint = urlsplit(base)
        if (endpoint.scheme != "https" or not endpoint.hostname or endpoint.username
                or endpoint.password or endpoint.query or endpoint.fragment or not key):
            raise ValueError
        if not 3 <= len(urls) <= 5 or len(set(urls)) != len(urls):
            raise ValueError
        if not 0 < minimum <= 1 or not math.isfinite(timeout) or not 10 <= timeout <= 240:
            raise ValueError
        for url in urls:
            listing = urlsplit(url)
            if (listing.scheme != "https" or listing.netloc != "www.auto24.ee"
                    or not listing.path.startswith("/soidukid/")
                    or not listing.path.removeprefix("/soidukid/").isdigit()
                    or listing.query or listing.fragment):
                raise ValueError
    except (KeyError, ValueError):
        print("Reveal check configuration missing or invalid. See docs/daily-reveal-check.md.")
        return 2

    results = []
    for url in urls:
        try:
            result = sample(base, key, url, timeout)
        except TimeoutError:
            result = "timeout"
        except Exception:
            # Exceptions and HTTP bodies can contain URLs, keys or vehicle data.
            result = "service_error"
        results.append(result)
    success = passed(results, minimum)
    report = (f"Daily reveal check: {'PASS' if success else 'FAIL'}\n"
              f"Revealed {results.count('revealed')}/{len(results)}; required {minimum:.0%}.\n"
              f"Outcomes: {json.dumps(dict(Counter(results)), sort_keys=True)}\n")
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write(report)
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
