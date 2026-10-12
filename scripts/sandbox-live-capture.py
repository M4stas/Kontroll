"""One live capture with a reveal, run inside the network sandbox.

Prints only statuses, per-attempt outcomes and per-round solver details. Never
prints revealed or listed registration numbers or VINs, tokens, cookies, URLs or
images.
"""

import argparse
import os
import time
from collections import Counter
from pathlib import Path

from auto24_service.browser import CaptureError, capture_listing
from auto24_service.captcha.assets import SolverFilesError, verify_solver_dir
from auto24_service.captcha.solver import load_solver
from auto24_service.contracts import AttemptRecord


def format_attempts(attempts: list[AttemptRecord]) -> list[str]:
    lines = [f"reveal attempts: {len(attempts)}"]
    for a in attempts:
        lines.append(
            f"attempt {a.attempt}: outcome={a.outcome} reason={a.reason} "
            f"rounds={len(a.rounds)} checkbox_only={a.checkbox_only} "
            f"error_type={a.error_type} stage={a.stage} duration_ms={a.duration_ms}"
        )
        for i, r in enumerate(a.rounds, 1):
            methods = Counter(t.method for t in r.tiles)
            lines.append(
                f"  round {i}: grid={r.grid} label_source={r.label_source} label={r.label} "
                f"label_id={r.label_id} result={r.result} stage={r.stage} duration_ms={r.duration_ms} "
                f"tiles lookup={methods['lookup']} model={methods['model']} none={methods['none']} "
                f"tiles_clicked={len(r.tiles_clicked)}"
            )
            # Google's generic challenge text, needed to debug label parsing.
            lines.append(f"    instruction={r.instruction!r}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument(
        "--deadline-seconds",
        type=float,
        default=None,
        help="finish the reveal this many seconds after start, like the worker's lease deadline",
    )
    parser.add_argument("--debug", action="store_true", help="save page screenshots and widget state")
    parser.add_argument("--debug-dir", default="/reports/debug", help="folder for --debug output")
    args = parser.parse_args()
    solver_dir = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
    try:
        verify_solver_dir(solver_dir)
    except (SolverFilesError, OSError) as exc:
        parser.error(f"CAPTCHA_SOLVER_DIR verification failed: {exc}")
    solver = load_solver(solver_dir)
    deadline = None if args.deadline_seconds is None else time.monotonic() + args.deadline_seconds
    print(f"deadline_seconds: {args.deadline_seconds}")
    try:
        debug = None
        if args.debug:
            from auto24_service.captcha.debug import DebugRecorder

            debug = DebugRecorder(Path(args.debug_dir))
            print(f"debug: on ({args.debug_dir})")
        result = capture_listing(args.url, solver=solver, deadline=deadline, debug=debug)
    except CaptureError as exc:
        print(f"capture failed: {exc.code}")
        return 1
    registration = result.registration
    if registration is None:
        print("registration: none")
    else:
        print(f"reg_number_status: {registration.reg_number_status}")
        print(f"vin_status: {registration.vin_status}")
    attempts = result.reveal_diagnostics.attempts if result.reveal_diagnostics else []
    for line in format_attempts(attempts):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
