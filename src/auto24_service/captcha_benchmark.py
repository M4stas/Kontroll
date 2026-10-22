"""Repeatable benchmark for the registration reveal: engine (Camoufox, Chromium) and
browser profile mode (fresh, saved, shared)."""

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
_MODES = ("fresh", "saved", "shared")
# Only these decide the exit code. `shared` and `saved` are reported, never gated.
_GATED_MODE = "fresh"


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
    engine: str, mode: str, n: int, url: str, attempts: list[Any], result: str,
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
    return {"engine": engine, "mode": mode, "n": n, "url": url, "result": result, "attempts": out,
            "field_statuses": _field_statuses(registration), "capture_duration_ms": capture_duration_ms,
            "capture_error": capture_error}


def _run_mode(
    engine: str,
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
    capture_kwargs: dict[str, Any] | None = None,
    profile: Path | None = None,
) -> dict[str, Any]:
    label = f"{engine}/{mode}"
    # A shared run owns its profile root in `main`, which removes it with the session.
    own_profile = profile is None and mode == "saved" and engine == "camoufox"
    if own_profile:
        profile = Path(tempfile.mkdtemp(prefix="bench-profile-"))
    from auto24_service.browser import CaptureError
    from auto24_service.warm_profile import WarmProfile

    warm_root = None
    warm = None
    profile_resets = 0
    if engine == "chromium" and mode == "saved":
        warm_root = Path(tempfile.mkdtemp(prefix="bench-warm-"))
    attempted = skipped = first = retry = checkbox = tries = lookup = decided = no_captcha = 0
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
        if warm_root is not None:
            warm = WarmProfile(warm_root)
        while attempted < reveals and calls < max_calls:
            url = urls[calls % len(urls)]
            listing = calls % len(urls) + 1
            calls += 1
            n = calls
            step = f"[{label} {attempted + 1}/{reveals}] listing {listing}"
            _progress(f"{step}: opening")

            def save(name: str, data: bytes, n: int = n) -> None:
                images.mkdir(parents=True, exist_ok=True)
                stem = Path(name).stem
                (images / f"{engine}-{mode}-{n}-{stem}.jpg").write_bytes(data)

            extra: dict[str, Any] = {}
            if debug_dir is not None:
                from auto24_service.captcha.debug import DebugRecorder

                extra["debug"] = DebugRecorder(debug_dir / f"{engine}-{mode}-{n}")
            # The worker's deadline: a fresh lease that starts with this capture.
            from auto24_service.store import LEASE_DURATION
            from auto24_service.worker import capture_deadline

            extra["deadline"] = capture_deadline(LEASE_DURATION.total_seconds())
            if warm is not None:
                extra["keep_profile"] = warm.path()
            capture_start = time.monotonic()
            error_code = None
            result = None
            try:
                result = capture(url, solver=solver, profile_dir=profile, save_image=save, **(capture_kwargs or {}), **extra)
            except Exception as exc:
                if warm is not None and isinstance(exc, CaptureError):
                    error_code = exc.code
                code = getattr(exc, "code", None) if type(exc).__name__ == "CaptureError" else None
                error = str(code or "error")
                errors[error] += 1
                # A capture error is a failed reveal, so it counts as attempted.
                attempted += 1
                duration = max(0, int((time.monotonic() - capture_start) * 1000))
                capture_durations.append(duration)
                if records is not None:
                    records.append(_reveal_record(engine, mode, n, url, [], "capture_error",
                                                 capture_duration_ms=duration, capture_error=error))
                _progress(f"{step}: capture error {code or type(exc).__name__}")
                continue
            finally:
                if warm is not None:
                    jobs = warm.jobs + 1
                    reason = warm.record_outcome(
                        error_code,
                        result.reveal_diagnostics if result is not None else None,
                        result.registration if result is not None else None,
                    )
                    _progress(f"profile_jobs={jobs}")
                    if reason is not None:
                        profile_resets += 1
                        _progress(f"profile_reset reason={reason}")
            duration = max(0, int((time.monotonic() - capture_start) * 1000))
            capture_durations.append(duration)
            for name, status in _field_statuses(result.registration).items():
                field_counts[name][status] += 1
            if not _needs_reveal(result.registration):
                skipped += 1
                if records is not None:
                    records.append(_reveal_record(engine, mode, n, url, [], "skipped",
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
                no_captcha += a1.outcome == "no_captcha_needed"
            elif a2 and a2.outcome in _OK and _all_revealed(result.registration):
                retry += 1
                verdict = "success_with_retry"
                no_captcha += a2.outcome == "no_captcha_needed"
            if records is not None:
                records.append(_reveal_record(engine, mode, n, url, attempts, verdict,
                                             registration=result.registration, capture_duration_ms=duration))
            notes = "; ".join(_attempt_note(a) for a in attempts)
            _progress(f"{step}: {verdict} ({notes or 'no attempts'}), {first} of {attempted} on attempt 1")
    finally:
        if warm_root is not None:
            shutil.rmtree(warm_root, ignore_errors=True)
        if own_profile and profile is not None and not keep_profile:
            shutil.rmtree(profile, ignore_errors=True)
    if mode != _GATED_MODE:
        gate = "NOT_GATED"
    elif attempted < GATE_MIN_ATTEMPTED:
        gate = "INSUFFICIENT"
    else:
        gate = "PASS" if first / attempted >= GATE_MIN_RATE else "FAIL"
    return {
        "engine": engine,
        "mode": mode,
        "attempted": attempted,
        "capture_errors_counted": True,
        "note": None,
        **({"profile_resets": profile_resets} if warm is not None else {}),
        "no_captcha_needed": no_captcha,
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
        "lookup_hit_rate": round(lookup / decided, 3) if decided and use_lookup and engine == "camoufox" else None,
        "label_source_counts": dict(sources),
        "try_again_later": tries,
        "reason_counts": dict(reasons),
        "capture_errors": dict(errors),
        "attempt_1_durations_ms": durations,
        "mean_attempt_1_duration_ms": round(sum(durations) / len(durations)) if durations else None,
        "profile_kept": str(profile) if own_profile and profile is not None and keep_profile else None,
        "gate": gate,
    }


def _rec_label(rec: dict[str, Any]) -> str:
    return f"{rec.get('engine', 'camoufox')}/{rec['mode']}"


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
        lines += ["", f"## {mode}: {m['gate']}", ""]
        for k, v in m.items():
            if k not in ("mode", "engine"):
                lines.append(f"- {k}: {v}")
    lines += ["", "## Captures", ""]
    for rec in report.get("reveals", []):
        lines.append(f"- {_rec_label(rec)} #{rec['n']} {rec['result']}: "
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
            f"- {_rec_label(rec)} #{rec['n']} attempt {a['attempt']} ({rec['result']}): "
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


def _summary(results: dict[str, dict[str, Any]], run_dir: Path, *, gated: bool = True) -> str:
    lines = []
    for mode, m in results.items():
        lines.append(
            f"{mode}: gate={m['gate']} attempted={m['attempted']} "
            f"success_attempt_1={m['success_attempt_1']} success_with_retry={m['success_with_retry']} "
            f"no_captcha_needed={m['no_captcha_needed']} lookup_hit_rate={m['lookup_hit_rate']}"
        )
        lines.append(f"  reasons: {m['reason_counts'] or 'none'}")
        if m["capture_errors"]:
            lines.append(f"  capture_errors: {m['capture_errors']}")
    if not gated:
        lines.append("no gated result: only fresh or saved results decide the gate, so this run exits 1")
    lines.append(f"report: {run_dir}")
    return "\n".join(lines)


def _run_shared(
    urls: list[str],
    run_one: Callable[..., None],
    shared_open: Callable[..., Any] | None,
    shared_opener_factory: Callable[[Any], Callable[..., Any]] | None,
) -> None:
    """One Chromium session for the whole run; every listing opens in a new page of it."""
    if shared_open is None:
        from auto24_service.browser_chromium import open_chromium_listing as shared_open
    if shared_opener_factory is None:
        from auto24_service.browser_chromium import shared_page_opener as shared_opener_factory
    from auto24_service.store import LEASE_DURATION
    from auto24_service.worker import capture_deadline

    # The session owns this profile root and removes its own profile on exit;
    # the root goes with the run.
    root = Path(tempfile.mkdtemp(prefix="bench-shared-"))
    try:
        _progress("[chromium/shared] opening the shared session")
        from contextlib import ExitStack

        from auto24_service.browser import CaptureError

        with ExitStack() as stack:
            # A listing that is gone or blocked must not sink the run: it is recorded as
            # a capture error and the session opens on the next one.
            session = None
            unopenable: dict[str, Exception] = {}
            for candidate in dict.fromkeys(urls):
                try:
                    session = stack.enter_context(shared_open(
                        candidate, profile_dir=root, deadline=capture_deadline(LEASE_DURATION.total_seconds())))
                    break
                except CaptureError as exc:
                    # Launch and readiness failures raise CaptureError. Any other error is a
                    # bug and propagates.
                    unopenable[candidate] = exc
                    _progress(f"[chromium/shared] session failed to open on a listing: {exc.code}")
            if session is None:
                # The session never started: every listing is a failed reveal, and the
                # results already collected still get their report.
                last = next(reversed(unopenable.values()))

                def failed(*args: Any, _exc: Exception = last, **kwargs: Any) -> Any:
                    raise _exc

                run_one("chromium", "shared", reveals=len(urls), capture_override=failed)
                return
            make_opener = shared_opener_factory(session)
            if unopenable:
                from contextlib import contextmanager

                @contextmanager
                def opener(url: str, **kwargs: Any):
                    if url in unopenable:
                        raise unopenable[url]
                    with make_opener(url, **kwargs) as child:
                        yield child
            else:
                opener = make_opener
            run_one("chromium", "shared", capture_kwargs={"opener": opener})
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main(
    argv: Sequence[str] | None = None,
    *,
    capture: Callable[..., Any] | None = None,
    solver_loader: Callable[[Path], Any] | None = None,
    chromium_capture: Callable[..., Any] | None = None,
    shared_open: Callable[..., Any] | None = None,
    shared_opener_factory: Callable[[Any], Callable[..., Any]] | None = None,
) -> int:
    parser = _Parser(prog="captcha_benchmark")
    parser.add_argument("--engine", choices=["camoufox", "chromium", "both"], default="camoufox")
    parser.add_argument("--mode", nargs="+", choices=[*_MODES, "both"], default=["fresh", "saved"], metavar="MODE",
                        help="one or more of: fresh saved shared (shared is Chromium only); both = fresh saved")
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

    engines = ["camoufox", "chromium"] if args.engine == "both" else [args.engine]
    modes = list(dict.fromkeys(m for x in args.mode for m in (("fresh", "saved") if x == "both" else (x,))))
    if "shared" in modes and "chromium" not in engines:
        return _err("--mode shared needs --engine chromium or both")
    from auto24_service.captcha.solver import parse_lookup_enabled

    try:
        use_lookup = parse_lookup_enabled(os.environ.get("CAPTCHA_LOOKUP_ENABLED"))
    except ValueError as exc:
        return _err(str(exc))
    solver_dir = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
    solvers: dict[str, Any] = {}
    if "camoufox" in engines:
        if capture is None:
            from auto24_service.browser import capture_listing as capture
        if solver_loader is None:
            from auto24_service.captcha.assets import SolverFilesError, verify_solver_dir
            from auto24_service.captcha.solver import load_solver as solver_loader

            try:
                verify_solver_dir(solver_dir)
            except (SolverFilesError, OSError) as exc:
                return _err(f"CAPTCHA_SOLVER_DIR verification failed: {exc}")
        solvers["camoufox"] = solver_loader(solver_dir, use_lookup=use_lookup)
    captures: dict[str, Callable[..., Any]] = {}
    if "camoufox" in engines:
        captures["camoufox"] = capture  # type: ignore[assignment]
    if "chromium" in engines:
        # The worker's wiring: the extension solves and the reveal only watches it.
        from auto24_service.captcha.extension_wait import EXTENSION

        solvers["chromium"] = EXTENSION
        if chromium_capture is None:
            import functools

            from auto24_service.browser import capture_listing
            from auto24_service.browser_chromium import open_chromium_listing
            from auto24_service.captcha.reveal import reveal_registration

            chromium_capture = functools.partial(
                capture_listing, opener=open_chromium_listing, reveal=reveal_registration, engine="chromium",
            )
        captures["chromium"] = chromium_capture

    started = datetime.now(timezone.utc)
    run_dir = args.out / f"{args.label}-{started.strftime('%Y%m%dT%H%M%SZ')}"
    run_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    results: dict[str, dict[str, Any]] = {}
    debug_dir = run_dir / "debug" if args.debug else None

    def run_one(engine: str, mode: str, *, reveals: int | None = None,
                capture_override: Callable[..., Any] | None = None, **more: Any) -> None:
        results[f"{engine}/{mode}"] = _run_mode(
            engine, mode, urls, reveals or args.reveals, solvers[engine], capture_override or captures[engine],
            run_dir / "images",
            args.keep_profile, records, debug_dir=debug_dir, use_lookup=use_lookup, **more,
        )

    for engine in engines:
        for mode in modes:
            if mode == "shared":
                continue
            run_one(engine, mode)
    if "shared" in modes:
        _run_shared(urls, run_one, shared_open, shared_opener_factory)
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
    gated = [m for m in results.values() if m["gate"] != "NOT_GATED"]
    print(_summary(results, run_dir, gated=bool(gated)), flush=True)
    # A run with no gated result (shared only) proves nothing, so it does not pass.
    return 0 if gated and all(m["gate"] == "PASS" for m in gated) else 1


if __name__ == "__main__":
    raise SystemExit(main())
