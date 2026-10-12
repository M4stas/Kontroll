"""Repeatable benchmark for the registration reveal: fresh vs saved browser profile."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
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


class _Parser(argparse.ArgumentParser):
    def error(self, message: str):  # type: ignore[override]
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
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)
    return urls


def _solver_hashes() -> dict[str, str]:
    from auto24_service.captcha.assets import read_sums

    sums = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver")) / "SHA256SUMS"
    try:
        return read_sums(sums)
    except (OSError, RuntimeError):
        return {}


def _run_mode(
    mode: str,
    urls: list[str],
    reveals: int,
    solver: Any,
    capture: Callable[..., Any],
    images: Path,
    keep_profile: bool,
) -> dict[str, Any]:
    profile = Path(tempfile.mkdtemp(prefix="bench-profile-")) if mode == "saved" else None
    attempted = skipped = first = retry = checkbox = tries = lookup = decided = 0
    rounds_per_success: list[int] = []
    sources: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    errors: Counter[str] = Counter()
    durations: list[int] = []
    calls = 0
    max_calls = max(reveals * 3, len(urls))
    try:
        while attempted < reveals and calls < max_calls:
            url = urls[calls % len(urls)]
            calls += 1
            n = calls

            def save(name: str, data: bytes, n: int = n) -> None:
                images.mkdir(parents=True, exist_ok=True)
                stem = Path(name).stem
                (images / f"{mode}-{n}-{stem}.jpg").write_bytes(data)

            try:
                result = capture(url, solver=solver, profile_dir=profile, save_image=save)
            except Exception as exc:
                code = getattr(exc, "code", None) if type(exc).__name__ == "CaptureError" else None
                errors[str(code or "error")] += 1
                continue
            if not _needs_reveal(result.registration):
                skipped += 1
                continue
            attempted += 1
            attempts = result.reveal_diagnostics.attempts if result.reveal_diagnostics else []
            for a in attempts:
                for r in a.rounds:
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
            if a1:
                durations.append(a1.duration_ms)
            if a1 and a1.outcome in _OK and _all_revealed(result.registration):
                first += 1
                rounds_per_success.append(len(a1.rounds))
                checkbox += bool(a1.checkbox_only)
            elif a2 and a2.outcome in _OK and _all_revealed(result.registration):
                retry += 1
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
        "success_rate": round(first / attempted, 3) if attempted else None,
        "checkbox_only_passes": checkbox,
        "rounds_per_success": rounds_per_success,
        "lookup_hit_rate": round(lookup / decided, 3) if decided else None,
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
    return "\n".join(lines) + "\n"


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
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    if not _LABEL.fullmatch(args.label) or args.reveals < 1:
        return 2
    try:
        urls = _read_listings(args.listings)
    except OSError:
        return 2
    if not urls:
        return 2

    if capture is None:
        from auto24_service.browser import capture_listing as capture
    solver_dir = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
    if solver_loader is None:
        from auto24_service.captcha.assets import SolverFilesError, verify_solver_dir
        from auto24_service.captcha.solver import load_solver as solver_loader

        try:
            verify_solver_dir(solver_dir)
        except (SolverFilesError, OSError) as exc:
            print(f"CAPTCHA_SOLVER_DIR verification failed: {exc}", file=sys.stderr)
            return 2
    solver = solver_loader(solver_dir)

    started = datetime.now(timezone.utc)
    run_dir = args.out / f"{args.label}-{started.strftime('%Y%m%dT%H%M%SZ')}"
    run_dir.mkdir(parents=True, exist_ok=True)
    modes = ["fresh", "saved"] if args.mode == "both" else [args.mode]
    results = {
        m: _run_mode(m, urls, args.reveals, solver, capture, run_dir / "images", args.keep_profile)
        for m in modes
    }
    report = {
        "label": args.label,
        "started_at": started.isoformat().replace("+00:00", "Z"),
        "package_version": _version("auto24-extraction-service"),
        "camoufox_version": _version("camoufox"),
        "solver_hashes": _solver_hashes(),
        "listings": urls,
        "modes": results,
    }
    (run_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (run_dir / "report.md").write_text(_markdown(report))
    return 0 if all(m["gate"] == "PASS" for m in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
