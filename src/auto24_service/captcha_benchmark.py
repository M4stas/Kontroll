"""Repeatable benchmark for the registration reveal: fresh vs saved browser profile."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any

GATE_MIN_ATTEMPTED = 10
GATE_MIN_RATE = 0.8
_LABEL = re.compile(r"[A-Za-z0-9_-]{1,40}")
_OK = ("revealed", "no_captcha_needed")


def _err(message: str) -> int:
    # print, not logging: `docker compose run` shows stderr whatever the logging config.
    print(f"captcha_benchmark: error: {message}", file=sys.stderr, flush=True)
    return 2


class _Parser(argparse.ArgumentParser):
    def error(self, message: str):  # type: ignore[override]
        self.print_usage(sys.stderr)
        _err(message)
        self.exit(2)


def _version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _needs_reveal(registration: Any) -> bool:
    if registration is None:
        return False
    return any(
        getattr(registration, f"{f}_status") in ("revealed", "unavailable")
        for f in ("reg_number", "vin")
    )


def _all_revealed(registration: Any) -> bool:
    for f in ("reg_number", "vin"):
        if getattr(registration, f"{f}_status") == "unavailable":
            return False
    return True


def _read_listings(path: Path) -> list[str]:
    urls = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)
    return urls


def _solver_hashes() -> dict[str, str]:
    from auto24_service.captcha.assets import PINNED_SOLVER_SHA256, verify_solver_dir

    directory = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
    try:
        verify_solver_dir(directory)
        return dict(PINNED_SOLVER_SHA256)
    except (OSError, RuntimeError):
        return {}


def _progress(message: str) -> None:
    """One line per step on stderr so a long run shows where it is. Never values."""
    print(f"captcha_benchmark: {message}", file=sys.stderr, flush=True)


def _attempt_note(a: Any) -> str:
    if not _attempt_started(a):
        return f"attempt {a.attempt} skipped ({a.reason or a.outcome})"
    rounds = len(a.rounds)
    tail = f"{a.reason}" if a.outcome == "failed" and a.reason else a.outcome
    return f"attempt {a.attempt} {tail} in {a.duration_ms / 1000:.1f} s, {rounds} round{'s' * (rounds != 1)}"


def _attempt_started(attempt: Any) -> bool:
    # Budget skips are synthetic zero-duration records without a stage. Reopen
    # failures have a stage even if they finish within the first millisecond.
    return bool(attempt.stage or attempt.duration_ms or attempt.rounds or attempt.outcome in _OK)


def _field_statuses(registration: Any) -> dict[str, str]:
    if registration is None:
        return {}
    return {name: getattr(registration, f"{name}_status") for name in ("reg_number", "vin")}


def _reveal_record(
    mode: str, n: int, url: str, attempts: list[Any], result: str,
    *, registration: Any = None, capture_duration_ms: int = 0, capture_error: str | None = None,
) -> dict[str, Any]:
    """Per-reveal record. Outcomes, stages and labels only: never values, tokens,
    cookies or images."""
    out = []
    for a in attempts:
        rounds = []
        for r in a.rounds:
            methods = Counter(t.method for t in r.tiles)
            rounds.append({
                "grid": r.grid,
                "label": r.label,
                "label_id": r.label_id,
                "label_source": r.label_source,
                "result": r.result,
                "stage": r.stage,
                "tile_methods": {m: methods[m] for m in ("lookup", "model", "none")},
            })
        out.append({
            "attempt": a.attempt,
            "started": _attempt_started(a),
            "outcome": a.outcome,
            "reason": a.reason,
            "stage": a.stage,
            "error_type": a.error_type,
            "pass_evidence": a.pass_evidence,
            "duration_ms": a.duration_ms,
            "rounds_count": len(a.rounds),
            "rounds": rounds,
        })
    return {"mode": mode, "n": n, "url": url, "result": result, "attempts": out,
            "field_statuses": _field_statuses(registration), "capture_duration_ms": capture_duration_ms,
            "capture_error": capture_error}


def _run_mode(
    mode: str,
    urls: list[str],
    reveals: int,
    solver: Any,
    capture: Callable[..., Any],
    images: Path,
    keep_profile: bool,
    records: list[dict[str, Any]] | None = None,
    debug_dir: Path | None = None,
    use_lookup: bool = False,
) -> dict[str, Any]:
    profile = Path(tempfile.mkdtemp(prefix="bench-profile-")) if mode == "saved" else None
    attempted = skipped = first = retry = checkbox = tries = lookup = decided = 0
    rounds_per_success: list[int] = []
    sources: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    errors: Counter[str] = Counter()
    durations: list[int] = []
    capture_durations: list[int] = []
    grids: Counter[str] = Counter()
    field_counts: dict[str, Counter[str]] = {name: Counter() for name in ("reg_number", "vin")}
    retry_started = retry_skipped = 0
    calls = 0
    max_calls = max(reveals * 3, len(urls))
    try:
        while attempted < reveals and calls < max_calls:
            url = urls[calls % len(urls)]
            listing = calls % len(urls) + 1
            calls += 1
            n = calls
            step = f"[{mode} {attempted + 1}/{reveals}] listing {listing}"
            _progress(f"{step}: opening")

            def save(name: str, data: bytes, n: int = n) -> None:
                images.mkdir(parents=True, exist_ok=True)
                stem = Path(name).stem
                (images / f"{mode}-{n}-{stem}.jpg").write_bytes(data)

            extra: dict[str, Any] = {}
            if debug_dir is not None:
                from auto24_service.captcha.debug import DebugRecorder

                extra["debug"] = DebugRecorder(debug_dir / f"{mode}-{n}")
            # The worker's deadline: a fresh lease that starts with this capture.
            from auto24_service.store import LEASE_DURATION
            from auto24_service.worker import capture_deadline

            extra["deadline"] = capture_deadline(LEASE_DURATION.total_seconds())
            capture_start = time.monotonic()
            try:
                result = capture(url, solver=solver, profile_dir=profile, save_image=save, **extra)
            except Exception as exc:
                code = getattr(exc, "code", None) if type(exc).__name__ == "CaptureError" else None
                error = str(code or "error")
                errors[error] += 1
                duration = max(0, int((time.monotonic() - capture_start) * 1000))
                capture_durations.append(duration)
                if records is not None:
                    records.append(_reveal_record(mode, n, url, [], "capture_error",
                                                 capture_duration_ms=duration, capture_error=error))
                _progress(f"{step}: capture error {code or type(exc).__name__}")
                continue
            duration = max(0, int((time.monotonic() - capture_start) * 1000))
            capture_durations.append(duration)
            for name, status in _field_statuses(result.registration).items():
                field_counts[name][status] += 1
            if not _needs_reveal(result.registration):
                skipped += 1
                if records is not None:
                    records.append(_reveal_record(mode, n, url, [], "skipped",
                                                 registration=result.registration, capture_duration_ms=duration))
                _progress(f"{step}: skipped, nothing to reveal")
                continue
            attempted += 1
            attempts = result.reveal_diagnostics.attempts if result.reveal_diagnostics else []
            for a in attempts:
                for r in a.rounds:
                    grids[r.grid] += 1
                    sources[r.label_source] += 1
                    if r.result == "try_again_later":
                        tries += 1
                    for t in r.tiles:
                        if t.method in ("lookup", "model"):
                            decided += 1
                            lookup += t.method == "lookup"
                if a.outcome == "failed" and a.reason:
                    reasons[str(a.reason)] += 1
            a1 = next((a for a in attempts if a.attempt == 1), None)
            a2 = next((a for a in attempts if a.attempt == 2), None)
            if a2 is not None:
                retry_started += _attempt_started(a2)
                retry_skipped += not _attempt_started(a2)
            if a1:
                durations.append(a1.duration_ms)
            verdict = "failed"
            if a1 and a1.outcome in _OK and _all_revealed(result.registration):
                first += 1
                rounds_per_success.append(len(a1.rounds))
                checkbox += bool(a1.checkbox_only)
                verdict = "success_attempt_1"
            elif a2 and a2.outcome in _OK and _all_revealed(result.registration):
                retry += 1
                verdict = "success_with_retry"
            if records is not None:
                records.append(_reveal_record(mode, n, url, attempts, verdict,
                                             registration=result.registration, capture_duration_ms=duration))
            notes = "; ".join(_attempt_note(a) for a in attempts)
            _progress(f"{step}: {verdict} ({notes or 'no attempts'}), {first} of {attempted} on attempt 1")
    finally:
        if profile is not None and not keep_profile:
            shutil.rmtree(profile, ignore_errors=True)
    if attempted < GATE_MIN_ATTEMPTED:
        gate = "INSUFFICIENT"
    else:
        gate = "PASS" if first / attempted >= GATE_MIN_RATE else "FAIL"
    return {
        "mode": mode,
        "attempted": attempted,
        "skipped": skipped,
        "success_attempt_1": first,
        "success_with_retry": retry,
        "retry_started": retry_started,
        "retry_skipped": retry_skipped,
        "field_status_counts": {name: dict(counts) for name, counts in field_counts.items()},
        "grid_counts": dict(grids),
        "capture_durations_ms": capture_durations,
        "success_rate": round(first / attempted, 3) if attempted else None,
        "checkbox_only_passes": checkbox,
        "rounds_per_success": rounds_per_success,
        # None with the lookup off: no tile could come from it.
        "lookup_hit_rate": round(lookup / decided, 3) if decided and use_lookup else None,
        "label_source_counts": dict(sources),
        "try_again_later": tries,
        "reason_counts": dict(reasons),
        "capture_errors": dict(errors),
        "attempt_1_durations_ms": durations,
        "mean_attempt_1_duration_ms": round(sum(durations) / len(durations)) if durations else None,
        "profile_kept": str(profile) if profile is not None and keep_profile else None,
        "gate": gate,
    }


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# Reveal benchmark: {report['label']}",
        "",
        f"- Started (UTC): {report['started_at']}",
        f"- Package version: {report['package_version']}",
        f"- Camoufox version: {report['camoufox_version']}",
        f"- Revision: {report['revision']}",
        f"- Deadline policy: {report['deadline_policy']}",
        f"- Lookup enabled: {str(report.get('lookup_enabled', False)).lower()}",
        f"- Debug: {str(report.get('debug', False)).lower()}",
        f"- Listings: {len(report['listings'])}",
        "",
    ]
    for url in report["listings"]:
        lines.append(f"  - {url}")
    lines += ["", "## Solver files", ""]
    lines += [f"- {n}: {h}" for n, h in report["solver_hashes"].items()] or ["- none found"]
    for mode, m in report["modes"].items():
        lines += ["", f"## Mode {mode}: {m['gate']}", ""]
        for k, v in m.items():
            if k != "mode":
                lines.append(f"- {k}: {v}")
    lines += ["", "## Captures", ""]
    for rec in report.get("reveals", []):
        lines.append(f"- {rec['mode']} #{rec['n']} {rec['result']}: "
                     f"fields={rec['field_statuses']} capture_ms={rec['capture_duration_ms']} "
                     f"error={rec['capture_error']} {rec['url']}")
    failed = [
        (rec, a)
        for rec in report.get("reveals", [])
        for a in rec["attempts"]
        if a["outcome"] == "failed"
    ]
    lines += ["", "## Failed attempts", ""]
    if not failed:
        lines.append("- none")
    for rec, a in failed:
        lines.append(
            f"- {rec['mode']} #{rec['n']} attempt {a['attempt']} ({rec['result']}): "
            f"reason={a['reason']} stage={a['stage']} error_type={a['error_type']} "
            f"started={a['started']} duration_ms={a['duration_ms']} rounds={a['rounds_count']} {rec['url']}"
        )
        for i, r in enumerate(a["rounds"], 1):
            m = r["tile_methods"]
            lines.append(
                f"  - round {i}: grid={r['grid']} label={r['label']} label_id={r['label_id']} "
                f"label_source={r['label_source']} result={r['result']} stage={r['stage']} "
                f"tiles lookup={m['lookup']} model={m['model']} none={m['none']}"
            )
    return "\n".join(lines) + "\n"


def _summary(results: dict[str, dict[str, Any]], run_dir: Path) -> str:
    lines = []
    for mode, m in results.items():
        lines.append(
            f"{mode}: gate={m['gate']} attempted={m['attempted']} "
            f"success_attempt_1={m['success_attempt_1']} success_with_retry={m['success_with_retry']} "
            f"lookup_hit_rate={m['lookup_hit_rate']}"
        )
        lines.append(f"  reasons: {m['reason_counts'] or 'none'}")
        if m["capture_errors"]:
            lines.append(f"  capture_errors: {m['capture_errors']}")
    lines.append(f"report: {run_dir}")
    return "\n".join(lines)


def main(
    argv: Sequence[str] | None = None,
    *,
    capture: Callable[..., Any] | None = None,
    solver_loader: Callable[[Path], Any] | None = None,
) -> int:
    parser = _Parser(prog="captcha_benchmark")
    parser.add_argument("--mode", choices=["fresh", "saved", "both"], default="both")
    parser.add_argument("--listings", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--reveals", type=int, default=10)
    parser.add_argument("--out", type=Path, default=Path("benchmarks"))
    parser.add_argument("--keep-profile", action="store_true")
    parser.add_argument("--revision", default="unknown", help="exact source revision used to build this image")
    parser.add_argument(
        "--debug", action="store_true",
        help="save page screenshots and widget state per reveal under <run>/debug/<mode>-<n>/",
    )
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    if not _LABEL.fullmatch(args.label):
        return _err(f"--label must match {_LABEL.pattern}")
    if args.reveals < 1:
        return _err("--reveals must be at least 1")
    if args.revision != "unknown" and not re.fullmatch(r"[0-9a-f]{6,40}", args.revision):
        return _err("--revision must be a 6 to 40 character Git commit hash")
    try:
        urls = _read_listings(args.listings)
    except OSError as exc:
        return _err(f"cannot read listings file {args.listings}: {exc.strerror or exc}")
    except UnicodeDecodeError:
        return _err(f"listings file {args.listings} is not UTF-8 text")
    if not urls:
        return _err(f"listings file {args.listings} has no URLs")

    if capture is None:
        from auto24_service.browser import capture_listing as capture
    from auto24_service.captcha.solver import parse_lookup_enabled

    try:
        use_lookup = parse_lookup_enabled(os.environ.get("CAPTCHA_LOOKUP_ENABLED"))
    except ValueError as exc:
        return _err(str(exc))
    solver_dir = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
    if solver_loader is None:
        from auto24_service.captcha.assets import SolverFilesError, verify_solver_dir
        from auto24_service.captcha.solver import load_solver as solver_loader

        try:
            verify_solver_dir(solver_dir)
        except (SolverFilesError, OSError) as exc:
            return _err(f"CAPTCHA_SOLVER_DIR verification failed: {exc}")
    solver = solver_loader(solver_dir, use_lookup=use_lookup)

    started = datetime.now(timezone.utc)
    run_dir = args.out / f"{args.label}-{started.strftime('%Y%m%dT%H%M%SZ')}"
    run_dir.mkdir(parents=True, exist_ok=True)
    modes = ["fresh", "saved"] if args.mode == "both" else [args.mode]
    records: list[dict[str, Any]] = []
    results = {
        m: _run_mode(
            m, urls, args.reveals, solver, capture, run_dir / "images", args.keep_profile, records,
            debug_dir=run_dir / "debug" if args.debug else None, use_lookup=use_lookup,
        )
        for m in modes
    }
    from auto24_service.store import LEASE_DURATION
    from auto24_service.worker import LEASE_SAFETY_SECONDS

    report = {
        "label": args.label,
        "started_at": started.isoformat().replace("+00:00", "Z"),
        "package_version": _version("auto24-extraction-service"),
        "camoufox_version": _version("camoufox"),
        "revision": args.revision,
        "deadline_policy": {"lease_seconds": LEASE_DURATION.total_seconds(),
                            "completion_margin_seconds": LEASE_SAFETY_SECONDS},
        "solver_hashes": _solver_hashes(),
        "lookup_enabled": use_lookup,
        "debug": args.debug,
        "listings": urls,
        "modes": results,
        "reveals": records,
    }
    (run_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (run_dir / "report.md").write_text(_markdown(report))
    print(_summary(results, run_dir), flush=True)
    return 0 if all(m["gate"] == "PASS" for m in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
